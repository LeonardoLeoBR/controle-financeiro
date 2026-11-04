/*
 * Controle Financeiro — camada de dados (F1).
 * A interface só fala com window.Dados; nunca com localStorage, db ou fetch diretamente.
 *
 * Ambientes (detectados pelo endereço da página):
 *  - homologacao: artifact no claude.ai. O navegador NÃO consegue chamar APIs externas (CSP do artifact).
 *      Persistência: banco do artifact (capability db), dados de teste. Mercado: snapshot gravado por Claude
 *      no documento mercado/snapshot.
 *  - producao: GitHub Pages. Chamada direta às APIs do BCB (CORS liberado, testado em 29/10/2026).
 *      Persistência: localStorage do navegador do Leo + backup JSON (exportar/importar).
 *
 * F1 (30/10/2026): séries Selic over (1178) e TR (226), Focus do ano seguinte e IPCA 12 meses à frente,
 *  premissas para o motor de renda fixa, calendário ANBIMA, cenário de referência e exemplos fictícios.
 * F2 (30/10/2026): senha opcional no backup (AES-GCM 256, chave derivada por PBKDF2-SHA256 com 600 mil
 *  iterações, recomendação da OWASP). Sem a senha o backup não pode ser aberto; não há recuperação.
 * F2 — porta, cofre e registro: toda leitura e gravação de dados do usuário passa pela Porta. Com o cofre
 *  ativo, os dados ficam cifrados no armazenamento e a chave só existe na memória desta página enquanto o site
 *  está desbloqueado. A Porta anota no registro de atividade a primeira leitura de cada tipo de dado na sessão
 *  e toda gravação; o registro é encadeado por SHA-256 e, com o cofre ativo, também cifrado e autenticado.
 */
(function (root) {
  'use strict';

  var VERSAO_SITE = '0.12.2';
  var VERSAO_ESQUEMA = 1;
  var PREFIXO = 'cf1:';
  var CHAVES_USUARIO = ['config', 'cenarios', 'carteira', 'proventos', 'radar'];
  /* Chaves cuja gravação nunca pode "fingir" sucesso guardando só na memória. */
  var PROTEGIDAS = CHAVES_USUARIO.concat(['cofre', 'cofreReserva', 'cofreNovo', 'registro', 'registroPendente', 'mercado', 'ultimoBackup', 'apagadoEm', 'quarentena']);

  var naArtifact = /\.claudeusercontent\.com$/.test(location.hostname);
  var AMBIENTE = root.CF_AMBIENTE || (naArtifact ? 'homologacao' : 'producao');

  /* Séries de mercado. Unidade conferida na resposta da API em 29–30/10/2026. */
  var SERIES = [
    { id: 'selic', nome: 'Selic meta', fonte: 'BCB SGS 432', codigo: 432, unidade: '% a.a.' },
    { id: 'selicOver', nome: 'Selic over (base 252)', fonte: 'BCB SGS 1178', codigo: 1178, unidade: '% a.a.' },
    { id: 'cdi', nome: 'CDI anualizado (base 252)', fonte: 'BCB SGS 4389', codigo: 4389, unidade: '% a.a.' },
    { id: 'ipca', nome: 'IPCA do mês', fonte: 'BCB SGS 433', codigo: 433, unidade: '% a.m.' },
    { id: 'tr', nome: 'TR (período mensal iniciado na data)', fonte: 'BCB SGS 226', codigo: 226, unidade: '% a.m.' }
  ];
  /* Focus: ano corrente (+0) e seguinte (+1); IPCA 12 meses à frente (série suavizada). */
  var FOCUS = [
    { id: 'focusIpca12m', nome: 'IPCA esperado 12 meses à frente (Focus, mediana)', indicador: 'IPCA', recurso: '12m', unidade: '% a.a.' },
    { id: 'focusIpca', nome: 'IPCA esperado (Focus, mediana)', indicador: 'IPCA', ano: 0, unidade: '% a.a.' },
    { id: 'focusIpcaProx', nome: 'IPCA esperado (Focus, mediana)', indicador: 'IPCA', ano: 1, unidade: '% a.a.' },
    { id: 'focusSelic', nome: 'Selic esperada fim de ano (Focus, mediana)', indicador: 'Selic', ano: 0, unidade: '% a.a.' },
    { id: 'focusSelicProx', nome: 'Selic esperada fim de ano (Focus, mediana)', indicador: 'Selic', ano: 1, unidade: '% a.a.' }
  ];

  /* ---------- Armazenamento ---------- */

  var memoria = {};
  var Local = {
    nome: 'navegador (localStorage)',
    ler: function (k) {
      try { var v = localStorage.getItem(PREFIXO + k); return Promise.resolve(v ? JSON.parse(v) : (memoria[k] || null)); }
      catch (e) { return Promise.resolve(memoria[k] || null); }
    },
    gravar: function (k, v) {
      try {
        if (v == null) localStorage.removeItem(PREFIXO + k); else localStorage.setItem(PREFIXO + k, JSON.stringify(v));
        return Promise.resolve(true);
      } catch (e) {
        // Dado do usuário ou do cofre: falha é falha (armazenamento cheio ou bloqueado). Só preferência de tela vai para a memória.
        if (PROTEGIDAS.indexOf(k) >= 0 || String(k).indexOf('novo_') === 0) return Promise.reject(new Error('o navegador recusou a gravação (espaço cheio ou armazenamento bloqueado)'));
        memoria[k] = v; Local.nome = 'memória (não persiste)';
        return Promise.resolve(true);
      }
    }
  };

  var dbPromessa = null;
  function abrirDb() {
    if (!dbPromessa) {
      dbPromessa = (async function () {
        if (!root.claude || !root.claude.use) return null;
        var db = await root.claude.use('db');
        var user = await root.claude.use('user');
        if (!db || !user) return null;
        var id = await user.id();
        return { db: db, base: 'data/users/' + id };
      })().catch(function () { return null; });
    }
    return dbPromessa;
  }
  function copia(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  var Artifact = {
    nome: 'banco do artifact',
    ler: async function (k) {
      var c = await abrirDb(); if (!c) return Local.ler(k);
      var snap = await c.db.doc(c.base + '/' + k).get();
      var d = snap && (typeof snap.data === 'function' ? snap.data() : snap.data);
      // Documentos lidos do banco vêm congelados: devolve cópia editável.
      return d ? copia(d.valor) : null;
    },
    gravar: async function (k, v) {
      var c = await abrirDb(); if (!c) return Local.gravar(k, v);
      await c.db.doc(c.base + '/' + k).set({ valor: copia(v), atualizadoEm: new Date().toISOString() });
      return true;
    }
  };

  var Armazenamento = AMBIENTE === 'homologacao' ? Artifact : Local;

  /* ---------- Mercado ---------- */

  function brParaIso(d) { var p = d.split('/'); return p[2] + '-' + p[1] + '-' + p[0]; }

  /* Data de hoje no fuso do navegador (Brasília), não em UTC. */
  function hojeLocal() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  var OLINDA = 'https://olinda.bcb.gov.br/olinda/servico/Expectativas/versao/v1/odata/';

  async function buscarDireto() {
    var hoje = hojeLocal();
    var saida = { series: {}, coletadoEm: new Date().toISOString(), origem: 'chamada direta às APIs do BCB', avisos: [] };
    await Promise.all(SERIES.map(async function (s) {
      try {
        var r = await fetch('https://api.bcb.gov.br/dados/serie/bcdata.sgs.' + s.codigo + '/dados/ultimos/20?formato=json', { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        // A API não garante ordem cronológica (4389 veio decrescente) e a 432 traz datas de vigência futura:
        // ordena por data e usa o último registro com data <= hoje.
        var lista = (await r.json()).map(function (x) { return { data: brParaIso(x.data), valor: x.valor }; })
          .sort(function (a, b) { return a.data < b.data ? -1 : a.data > b.data ? 1 : 0; });
        var validos = lista.filter(function (x) { return x.data <= hoje; });
        if (!validos.length) throw new Error('nenhum registro até hoje nos últimos 20');
        var ult = validos[validos.length - 1];
        saida.series[s.id] = { nome: s.nome, valor: parseFloat(ult.valor), data: ult.data, unidade: s.unidade, fonte: s.fonte };
      } catch (e) { saida.avisos.push('falta ' + s.nome + ' (' + e.message + ')'); }
    }));
    var ano = Number(hoje.slice(0, 4));
    await Promise.all(FOCUS.map(async function (f) {
      try {
        var u;
        if (f.recurso === '12m') {
          u = OLINDA + 'ExpectativasMercadoInflacao12Meses?$top=1&$filter=Indicador%20eq%20%27' + f.indicador +
            "%27%20and%20Suavizada%20eq%20%27S%27%20and%20baseCalculo%20eq%200&$orderby=Data%20desc&$select=Data,Mediana&$format=json";
        } else {
          u = OLINDA + 'ExpectativasMercadoAnuais?$top=1&$filter=Indicador%20eq%20%27' + f.indicador + '%27%20and%20DataReferencia%20eq%20%27' +
            (ano + f.ano) + "%27%20and%20baseCalculo%20eq%200&$orderby=Data%20desc&$select=Data,DataReferencia,Mediana&$format=json";
        }
        var r = await fetch(u, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var v = (await r.json()).value[0];
        if (!v) throw new Error('sem resposta do Focus');
        saida.series[f.id] = { nome: f.nome + (v.DataReferencia ? ' ' + v.DataReferencia : ''), valor: v.Mediana, data: v.Data, unidade: f.unidade, fonte: 'BCB Focus (Olinda)', projecao: true };
      } catch (e) { saida.avisos.push('falta ' + f.nome + ' (' + e.message + ')'); }
    }));
    return saida;
  }

  async function lerSnapshot() {
    var c = await abrirDb();
    if (!c) return { series: {}, coletadoEm: null, origem: 'snapshot indisponível', avisos: ['banco do artifact indisponível nesta visualização'] };
    var snap = await c.db.doc('mercado/snapshot').get();
    var d = snap && (typeof snap.data === 'function' ? snap.data() : snap.data);
    if (!d) return { series: {}, coletadoEm: null, origem: 'snapshot ainda não gravado', avisos: ['Claude ainda não gravou o snapshot de mercado'] };
    var c2 = copia(d);
    c2.avisos = c2.avisos || [];
    return c2;
  }

  /* Confere cada série guardada: só séries conhecidas, valor numérico em faixa plausível e data válida.
     Nome, fonte e unidade vêm do código (não do valor guardado), para um dado plantado não se passar pelo BCB. */
  var FAIXAS = { selic: [0, 40], selicOver: [0, 40], cdi: [0, 40], ipca: [-3, 5], tr: [-1, 3],
    focusIpca12m: [-5, 40], focusIpca: [-5, 40], focusIpcaProx: [-5, 40], focusSelic: [0, 40], focusSelicProx: [0, 40] };
  function sanear(m) {
    if (!m || typeof m !== 'object' || !m.series || typeof m.series !== 'object') return null;
    var saida = { series: {}, coletadoEm: typeof m.coletadoEm === 'string' ? m.coletadoEm : null,
      origem: typeof m.origem === 'string' ? m.origem.slice(0, 200) : '', avisos: Array.isArray(m.avisos) ? m.avisos.filter(function (a) { return typeof a === 'string'; }).slice(0, 20) : [] };
    Object.keys(m.series).forEach(function (id) {
      var s = m.series[id], def = SERIES.concat(FOCUS).filter(function (x) { return x.id === id; })[0], f = FAIXAS[id];
      if (!def || !f || !s) return;
      if (typeof s.valor !== 'number' || !isFinite(s.valor) || s.valor < f[0] || s.valor > f[1] || typeof s.data !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(s.data)) {
        alerta('valor de mercado fora do esperado em "' + def.nome + '"; descartado'); return;
      }
      var ano = def.ano != null && typeof s.nome === 'string' ? (s.nome.match(/(20\d\d)$/) || [])[1] : null;
      saida.series[id] = { nome: def.nome + (ano ? ' ' + ano : ''), valor: s.valor, data: s.data.slice(0, 10), unidade: def.unidade,
        fonte: def.fonte || 'BCB Focus (Olinda)', projecao: !def.codigo };
    });
    return saida;
  }

  var Mercado = {
    SERIES: SERIES, FOCUS: FOCUS,
    /* Botão "Atualizar". Produção: chama o BCB. Homologação: relê o snapshot gravado por Claude. */
    atualizar: async function () {
      var m = sanear(AMBIENTE === 'producao' ? await buscarDireto() : await lerSnapshot()) || { series: {}, avisos: [] };
      if (Object.keys(m.series).length) await gravarAux('mercado', m);
      return m;
    },
    ultimo: async function () { return sanear(await lerAux('mercado')); }
  };
  SERIES.forEach(Object.freeze); FOCUS.forEach(Object.freeze); Object.freeze(SERIES); Object.freeze(FOCUS); Object.freeze(Mercado);

  /*
   * Converte um retrato de mercado nas premissas do motor de renda fixa (decimais),
   * com fonte e data de cada uma. Valor ausente fica null (a tela mostra "⚠ falta").
   */
  function premissasDe(m) {
    var s = (m && m.series) || {};
    function p(id, nome, divisor, extra) {
      var x = s[id];
      return Object.assign({ nome: nome, valor: x ? x.valor / divisor : null, data: x ? x.data : null,
        fonte: x ? x.fonte : null, unidade: x ? x.unidade : null, projecao: !!(x && x.projecao) }, extra || {});
    }
    return {
      cdiAA: p('cdi', 'CDI', 100, { usoEm: 'produtos atrelados ao CDI e fundos' }),
      selicAA: p('selicOver', 'Selic over', 100, { usoEm: 'Tesouro Selic' }),
      selicMetaAA: p('selic', 'Selic meta', 100, { usoEm: 'regra da poupança (acima ou abaixo de 8,5% a.a.)' }),
      trAM: p('tr', 'TR', 100, { usoEm: 'poupança' }),
      ipcaProjAA: p('focusIpca12m', 'IPCA projetado', 100, { usoEm: 'IPCA+ e retorno real' })
    };
  }

  /* ---------- Arquivos estáticos do site (mesma origem) ---------- */

  var cacheArq = {};
  function lerJson(caminho) {
    if (!cacheArq[caminho]) {
      cacheArq[caminho] = fetch(caminho, { cache: 'no-cache' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' em ' + caminho);
        return r.json();
      });
      cacheArq[caminho].catch(function () { delete cacheArq[caminho]; });
    }
    return cacheArq[caminho].then(copia);
  }

  /* Dias úteis (segunda a sexta, sem feriados) desde uma data — usado para o selo "desatualizado". */
  function diasUteisDesde(iso) {
    var d = new Date(iso), h = new Date(), n = 0;
    d.setHours(0, 0, 0, 0); h.setHours(0, 0, 0, 0);
    if (isNaN(d) || d >= h) return 0;
    // Semanas inteiras de uma vez (7ª revisão, N7: data muito antiga fazia o laço andar dia a dia por décadas).
    var semanas = Math.floor(Math.round((h - d) / 86400000) / 7);
    n = semanas * 5; d.setDate(d.getDate() + semanas * 7);
    while (d < h) { d.setDate(d.getDate() + 1); var w = d.getDay(); if (w !== 0 && w !== 6) n++; }
    return n;
  }

  /* ---------- Backup ---------- */

  /* ---------- Cifragem do backup (opcional, por senha) ----------
   * Formato cifrado: o cabeçalho (app, esquema, versaoSite, ambiente, exportadoEm) fica legível e entra como
   * dado autenticado (AAD) — alterar o cabeçalho também invalida o arquivo. a seção dados vira dadosCifrados (base64).
   * A senha nunca é gravada; só existe enquanto o usuário digita.
   */
  var CRIPTO = { alg: 'AES-GCM-256', kdf: 'PBKDF2-SHA256', iteracoes: 600000, minIter: 100000, maxIter: 5000000 };

  function criptoDisponivel() { return !!(root.crypto && root.crypto.subtle && root.isSecureContext !== false); }
  function paraB64(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function deB64(t) { var s = atob(t), b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
  function cabecalho(o) {
    return new TextEncoder().encode(JSON.stringify({ app: o.app, esquema: o.esquema, versaoSite: o.versaoSite, ambiente: o.ambiente, exportadoEm: o.exportadoEm }));
  }
  async function derivarChave(senha, sal, iteracoes) {
    var base = await root.crypto.subtle.importKey('raw', new TextEncoder().encode(String(senha).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return root.crypto.subtle.deriveKey({ name: 'PBKDF2', salt: sal, iterations: iteracoes, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  var Backup = {
    criptoDisponivel: criptoDisponivel,
    estaCifrado: function (obj) { return !!(obj && obj.cifrado && typeof obj.dadosCifrados === 'string'); },
    /* Recebe o backup aberto (de exportar) e devolve a versão cifrada. */
    cifrar: async function (b, senha) {
      if (!criptoDisponivel()) throw new Error('este navegador não oferece criptografia nesta página');
      if (!senha) throw new Error('senha vazia');
      var sal = root.crypto.getRandomValues(new Uint8Array(16));
      var iv = root.crypto.getRandomValues(new Uint8Array(12));
      var chave = await derivarChave(senha, sal, CRIPTO.iteracoes);
      var texto = new TextEncoder().encode(JSON.stringify(b.dados));
      var ct = await root.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: cabecalho(b) }, chave, texto);
      return { app: b.app, esquema: b.esquema, versaoSite: b.versaoSite, ambiente: b.ambiente, exportadoEm: b.exportadoEm,
        cifrado: { alg: CRIPTO.alg, kdf: CRIPTO.kdf, iteracoes: CRIPTO.iteracoes, sal: paraB64(sal), iv: paraB64(iv) },
        dadosCifrados: paraB64(ct) };
    },
    /* Com o cofre ativo, o backup sai cifrado com a chave do cofre (mesmo sal e iterações): abre com a senha do site. */
    cifrarComCofre: async function (b) {
      if (!cofre.chave || !cofre.meta) throw new Error('o site está sem senha ou travado');
      var iv = root.crypto.getRandomValues(new Uint8Array(12));
      var ct = await root.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: cabecalho(b) }, cofre.chave, new TextEncoder().encode(JSON.stringify(b.dados)));
      return { app: b.app, esquema: b.esquema, versaoSite: b.versaoSite, ambiente: b.ambiente, exportadoEm: b.exportadoEm,
        cifrado: { alg: CRIPTO.alg, kdf: CRIPTO.kdf, iteracoes: cofre.meta.iteracoes, sal: cofre.meta.sal, iv: paraB64(iv) },
        dadosCifrados: paraB64(ct) };
    },
    /* Confere o cabeçalho de um arquivo cifrado antes de pedir a senha. */
    validarCifrado: function (obj) {
      var erros = [], c = obj && obj.cifrado;
      if (!obj || obj.app !== 'controle-financeiro') erros.push('o arquivo não é um backup do Controle Financeiro');
      else if (obj.esquema > VERSAO_ESQUEMA) erros.push('backup feito por versão mais nova do site (esquema ' + obj.esquema + ')');
      else if (!c || c.alg !== CRIPTO.alg || c.kdf !== CRIPTO.kdf) erros.push('formato de cifragem desconhecido');
      else if (!(c.iteracoes >= CRIPTO.minIter && c.iteracoes <= CRIPTO.maxIter)) erros.push('parâmetro de cifragem fora do esperado');
      else if (typeof c.sal !== 'string' || typeof c.iv !== 'string') erros.push('arquivo cifrado incompleto');
      return { ok: !erros.length, erros: erros, exportadoEm: obj && obj.exportadoEm, ambiente: obj && obj.ambiente };
    },
    /* Devolve o backup aberto, no mesmo formato de exportar. Senha errada ou arquivo alterado → erro. */
    decifrar: async function (obj, senha) {
      if (!criptoDisponivel()) throw new Error('este navegador não oferece criptografia nesta página');
      var v = Backup.validarCifrado(obj); if (!v.ok) throw new Error(v.erros.join('; '));
      var texto;
      try {
        var chave = await derivarChave(senha, deB64(obj.cifrado.sal), obj.cifrado.iteracoes);
        var claro = await root.crypto.subtle.decrypt({ name: 'AES-GCM', iv: deB64(obj.cifrado.iv), additionalData: cabecalho(obj) }, chave, deB64(obj.dadosCifrados));
        texto = new TextDecoder().decode(claro);
      } catch (e) { throw new Error('senha incorreta ou arquivo alterado'); }
      return { app: obj.app, esquema: obj.esquema, versaoSite: obj.versaoSite, ambiente: obj.ambiente, exportadoEm: obj.exportadoEm, dados: JSON.parse(texto) };
    },
    /* tolerante: dado ilegível vira null (usado para guardar o estado anterior antes de importar). */
    exportar: async function () {
      var dados = {}, omitidos = [];
      for (var i = 0; i < CHAVES_USUARIO.length; i++) {
        // Dado ilegível não impede o backup do resto: fica de fora e é avisado.
        try { dados[CHAVES_USUARIO[i]] = await Porta.ler(CHAVES_USUARIO[i]); }
        catch (e) { dados[CHAVES_USUARIO[i]] = null; omitidos.push(CHAVES_USUARIO[i]); }
      }
      // Cenários inválidos que não couberam na área separada continuam neste navegador, mas não vão no backup: avisa.
      if (invalidosPendentes.cenarios && invalidosPendentes.cenarios.length) omitidos.push(invalidosPendentes.cenarios.length + ' cenário(s) inválido(s) que ficaram neste navegador');
      var agora = new Date().toISOString();
      await gravarAux('ultimoBackup', agora);
      await registrar('backup-exportado', cofre.chave ? 'cifrado com a senha do site' : '');
      var b = { app: 'controle-financeiro', esquema: VERSAO_ESQUEMA, versaoSite: VERSAO_SITE, ambiente: AMBIENTE, exportadoEm: agora, dados: dados };
      if (omitidos.length) Object.defineProperty(b, 'omitidos', { value: omitidos, enumerable: false });
      return b;
    },
    validar: function (obj) {
      var erros = [];
      if (!obj || obj.app !== 'controle-financeiro') erros.push('o arquivo não é um backup do Controle Financeiro');
      else {
        if (obj.esquema > VERSAO_ESQUEMA) erros.push('backup feito por versão mais nova do site (esquema ' + obj.esquema + ')');
        if (!obj.dados || typeof obj.dados !== 'object') erros.push('backup sem a seção de dados');
        else {
          // Marcas internas (exemplo, referência, mercado fixo) nunca vêm de backup: são removidas antes de validar.
          var marcas = 0;
          if (Array.isArray(obj.dados.cenarios)) obj.dados.cenarios = obj.dados.cenarios.map(function (c) { var l = limparCenario(c); marcas += l.removidas; return l.c; });
          var desconhecidas = Object.keys(obj.dados).filter(function (k) { return CHAVES_USUARIO.indexOf(k) < 0; });
          if (desconhecidas.length) erros.push('seção desconhecida no backup');
          else CHAVES_USUARIO.forEach(function (k) { var ek = validarChave(k, obj.dados[k]); if (ek) erros.push(k === 'cenarios' ? ek : k + ': ' + ek); });
        }
      }
      var resumo = {};
      if (!erros.length) CHAVES_USUARIO.forEach(function (k) {
        var v = obj.dados[k];
        if (k === 'carteira') { resumo.lancamentos = v == null ? 0 : v.lancamentos.length; return; }
        if (k === 'proventos') { resumo.rendimentos = v == null ? 0 : v.itens.length; return; }
        resumo[k] = v == null ? 0 : (Array.isArray(v) ? v.length : Object.keys(v).length);
      });
      return { ok: !erros.length, erros: erros, resumo: resumo, exportadoEm: obj && obj.exportadoEm, ambiente: obj && obj.ambiente, marcasRemovidas: marcas || 0 };
    },
    /* Substitui os dados. Devolve o estado anterior para permitir desfazer. */
    restaurar: async function (obj) {
      obj = copia(obj);   // valida e grava a mesma cópia (7ª revisão, N6: objeto que muda entre validar e gravar)
      var v = Backup.validar(obj); if (!v.ok) throw new Error(v.erros.join('; '));
      var anterior = await Backup.exportar();
      await restaurarDados(obj.dados);
      await registrar('backup-importado', 'backup de ' + (obj.exportadoEm || '?'));
      try { document.dispatchEvent(new CustomEvent('cf:dados-restaurados')); } catch (e) {}
      return anterior;
    },
    ultimo: function () { return lerAux('ultimoBackup'); }
  };


  /* =================== Porta, cofre e registro (F2) ===================
   * Porta: única passagem entre a tela e os dados do usuário. Nada fora deste arquivo fala com o armazenamento.
   * Cofre: senha única do site. Chave AES-GCM 256 derivada por PBKDF2-SHA256 (600 mil iterações), não exportável,
   *   guardada só em memória. Cada valor é cifrado com IV próprio e com o nome da chave como dado autenticado.
   *   Esquecer a senha = perder os dados (não há recuperação).
   * Registro: o que passou pela Porta (primeira leitura de cada dado na sessão, toda gravação), desbloqueios,
   *   senhas erradas, travamentos, backups e alertas. Cada linha guarda o SHA-256 da anterior.
   * v0.5.0 (revisão independente de 30/10/2026): na dúvida, recusa e trava (nunca grava sem cifra com o cofre
   *   ativo); configuração do cofre em duas cópias; criar/trocar/remover em duas fases (prepara, confere, vira);
   *   várias abas travam juntas; registro pendente só aceita senha errada; mercado e último backup no cofre;
   *   validação dos cenários; senha com no mínimo 12 caracteres e sem padrões óbvios.
   * v0.6.0 (2ª revisão independente, 31/10/2026): plano de troca de senha autenticado e só executado depois da senha;
   *   trava entre abas (Web Locks) cobrindo conferência, cifra e gravação; desbloqueio nunca sobrescreve configuração
   *   de outra aba; cenário inválido vai para a quarentena (cifrada) sem esconder os outros; dado ilegível nunca é
   *   sobrescrito sem pedido explícito; marcas de exemplo/referência e mercado fixo nunca vêm de dado do usuário.
   *   Limite: leitura feita por fora da Porta não aparece no registro (com o cofre ativo, só encontra texto cifrado).
   */
  var CHAVES_COFRE = CHAVES_USUARIO.concat(['registro', 'mercado', 'ultimoBackup', 'quarentena']);
  var REG_MAX = 1000;
  var cofre = { meta: null, metaAlternativa: null, chave: null, travando: false, comprometido: null, bloqueio: null, avisos: [],
    plano: null, planoCriacao: false };
  var ilegivel = {};      // chave cuja última leitura falhou: não é sobrescrita sem pedido explícito
  var bloqueioGravacao = null;   // operação pela metade: nada é gravado até a página recarregar e concluí-la
  var liberar; var pronto = new Promise(function (r) { liberar = r; });
  var lidasNaSessao = {};
  var alertasSessao = [];
  var filaTravada = [];   // eventos com o site travado (exceto senha errada): entram no registro após o desbloqueio
  var ocupado = false;    // exclusão mútua para criar/trocar/remover

  function ehCifrado(v) { return !!(v && v.__cofre === 1 && typeof v.iv === 'string' && typeof v.ct === 'string'); }
  function metaValida(m) {
    return !!(m && m.versao === 1 && typeof m.sal === 'string' && ehCifrado(m.verificador) &&
      m.iteracoes >= CRIPTO.minIter && m.iteracoes <= CRIPTO.maxIter);
  }
  function aad(k) { return new TextEncoder().encode('cf1:' + k); }
  async function cifrarValor(k, v, chave) {
    var iv = root.crypto.getRandomValues(new Uint8Array(12));
    var ct = await root.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: aad(k) }, chave || cofre.chave, new TextEncoder().encode(JSON.stringify(v)));
    return { __cofre: 1, iv: paraB64(iv), ct: paraB64(ct) };
  }
  async function decifrarValor(k, v, chave) {
    var claro = await root.crypto.subtle.decrypt({ name: 'AES-GCM', iv: deB64(v.iv), additionalData: aad(k) }, chave || cofre.chave, deB64(v.ct));
    return JSON.parse(new TextDecoder().decode(claro));
  }

  /* ---------- várias abas: travar uma trava todas; mudança na senha em outra aba trava esta ---------- */
  var canal = null;
  try { canal = new BroadcastChannel('cf1'); } catch (e) {}
  function avisarAbas(t) {
    try { if (canal) canal.postMessage({ t: t }); } catch (e) {}
    // Reserva para navegador sem BroadcastChannel: sinal pelo evento "storage" (sem dado do usuário).
    try { localStorage.setItem(PREFIXO + 'sinal', JSON.stringify({ t: t, r: Math.random() })); } catch (e) {}
  }
  function receberSinal(t) {
    if (t === 'travar') travarEstaAba('travado em outra aba');
    else if (t === 'cofre-mudou') travarEstaAba('a senha do site mudou em outra aba');
  }
  function travarEstaAba(motivo) {
    if (cofre.travando) return;
    cofre.travando = true; cofre.chave = null;
    try { document.body.classList.add('travado'); } catch (e) {}
    try { sessionStorage.setItem('cf1:motivoTrava', motivo); } catch (e) {}
    location.reload();
  }
  if (canal) canal.onmessage = function (ev) { receberSinal(ev && ev.data && ev.data.t); };
  try {
    root.addEventListener('storage', function (e) {
      if (e.key === PREFIXO + 'cofre' || e.key === PREFIXO + 'cofreReserva') travarEstaAba('a configuração da senha mudou em outra aba');
      else if (e.key === PREFIXO + 'sinal' && !canal && e.newValue) { try { receberSinal(JSON.parse(e.newValue).t); } catch (er) {} }
    });
  } catch (e) {}

  /* Exclusão mútua entre abas (Web Locks): 'shared' em cada gravação, 'exclusive' ao criar/trocar/remover a senha,
     restaurar backup, concluir plano e refazer cópias da configuração. Sem a API, segue sem trava (navegador antigo). */
  function comTrava(modo, fn) {
    try { if (root.navigator && root.navigator.locks && root.navigator.locks.request) return root.navigator.locks.request('cf1-cofre', { mode: modo }, fn); } catch (e) {}
    return fn();
  }

  /* Antes de gravar com a chave: a configuração guardada ainda é a desta aba? */
  async function conferirMetaGuardada() {
    var m = await Armazenamento.ler('cofre');
    if (!metaValida(m) || m.sal !== cofre.meta.sal) { travarEstaAba('a senha do site mudou em outra aba'); throw new Error('a senha do site mudou em outra aba'); }
  }

  /* Leitura e gravação com cifra, sem registro (uso interno). */
  async function lerSeguro(k) {
    var v = await Armazenamento.ler(k);
    if (v == null) return null;
    if (ehCifrado(v)) {
      if (!cofre.chave) throw new Error('o site está travado');
      try { return await decifrarValor(k, v); }
      catch (e) { avisar(k, 'o dado "' + k + '" foi alterado fora do site ou está corrompido; não foi aberto'); throw new Error('dado "' + k + '" alterado ou corrompido'); }
    }
    if (cofre.meta) {
      // Com o cofre ativo todo dado fica cifrado: um valor aberto aqui foi colocado por fora do site. Ignora.
      avisar(k, 'dado "' + k + '" sem cifra encontrado com o cofre ativo (possível alteração externa); ignorado');
      if (k === 'registro') throw new Error('registro sem cifra');
      return null;
    }
    return v;
  }
  async function gravarSeguro(k, v, conferir) {
    if (cofre.comprometido || cofre.bloqueio) throw new Error('gravação bloqueada');
    // O ramo (com ou sem cifra) é decidido dentro da trava: uma criação ou remoção de senha em andamento nesta aba
    // termina antes, e a gravação já usa o estado novo (antes, era recusada com um motivo falso).
    // conferir (opcional): roda dentro da trava, antes de gravar; com ela a trava é exclusiva (conferência e gravação juntas).
    return comTrava(conferir ? 'exclusive' : 'shared', async function () {
      if (cofre.meta && !cofre.chave) throw new Error('o site está travado');   // nunca grava sem cifra com o cofre ativo
      if (conferir) await conferir();
      return cofre.chave ? gravarComCifra(k, v) : gravarSemCifra(k, v);
    });
  }
  async function gravarComCifra(k, v) {
        await conferirMetaGuardada();
        if (await Armazenamento.ler('cofreNovo')) throw new Error('há uma operação de senha ou importação pela metade; recarregue a página para concluí-la');
        var g = v == null ? null : await cifrarValor(k, v);
        // Reconfere depois da cifra: outra aba pode ter trocado a senha enquanto esta cifrava.
        if (cofre.travando || !cofre.chave) throw new Error('o site está travando');
        await conferirMetaGuardada();
        await Armazenamento.gravar(k, g);
        return g;   // o valor bruto gravado (para a conferência de versão entre abas)
  }
  async function gravarSemCifra(k, v) {
      // Sem cofre nesta aba: outra aba pode ter criado a senha, ou há dado cifrado de antes.
      if (metaValida(await Armazenamento.ler('cofre'))) { travarEstaAba('a senha do site foi criada em outra aba'); throw new Error('a senha do site foi criada em outra aba'); }
      if (ehCifrado(await Armazenamento.ler(k))) throw new Error('há dado cifrado e o site está sem senha');
      if (await Armazenamento.ler('cofreNovo')) throw new Error('há uma importação pela metade; recarregue a página para concluí-la');
      await Armazenamento.gravar(k, v);
      return v;
  }

  function alerta(t, semRegistro) {
    alertasSessao.push({ em: new Date().toISOString(), texto: t });
    if (!semRegistro) registrar('alerta', t);
    try { document.dispatchEvent(new CustomEvent('cf:alerta', { detail: t })); } catch (e) {}
  }
  /* Problema no próprio registro não pode gerar linha no registro (laço): só avisa; o registrar recomeça o encadeamento. */
  function avisar(k, t) { alerta(t, k === 'registro'); }

  async function hashHex(texto) {
    if (!criptoDisponivel()) return '';
    var d = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
    return Array.prototype.map.call(new Uint8Array(d), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function linhaHash(e) { return JSON.stringify([e.n, e.em, e.tipo, e.detalhe]); }
  var filaReg = Promise.resolve();
  function registrar(tipo, detalhe) {
    var em = new Date().toISOString();
    filaReg = filaReg.then(async function () {
      try {
        if (cofre.comprometido || cofre.bloqueio) { if (tipo !== 'senha-errada') filaTravada.push({ em: em, tipo: tipo, detalhe: detalhe || '' }); return; }
        if (cofre.meta && !cofre.chave) {
          if (tipo !== 'senha-errada') { filaTravada.push({ em: em, tipo: tipo, detalhe: detalhe || '' }); return; }
          // Senha errada com o site travado: sem chave para cifrar; anota à parte (só o horário).
          var p = (await Armazenamento.ler('registroPendente')) || [];
          if (!Array.isArray(p)) p = [];
          p.push({ em: em, tipo: 'senha-errada' }); await Armazenamento.gravar('registroPendente', p.slice(-200));
          return;
        }
        var r = null, falhou = false;
        try { r = await lerSeguro('registro'); } catch (e) { r = null; falhou = true; }
        if (!r || !Array.isArray(r.itens)) r = { n: 0, h: '', base: '', itens: [] };
        async function anexar(t, d, quando) {
          var e = { n: r.n + 1, em: quando || em, tipo: t, detalhe: d || '' };
          e.h = await hashHex(r.h + linhaHash(e));
          r.itens.push(e); r.n = e.n; r.h = e.h;
        }
        if (falhou) await anexar('alerta', 'o registro anterior estava alterado ou ilegível; um novo registro foi iniciado');
        await anexar(tipo, detalhe);
        // Identificadores de planos concluídos ficam numa lista própria, que não "rola" com o limite de linhas.
        if (tipo === 'plano-concluido' && detalhe) { r.concluidos = (Array.isArray(r.concluidos) ? r.concluidos : []).concat([detalhe]).slice(-500); }
        if (r.itens.length > REG_MAX) { var fora = r.itens.splice(0, r.itens.length - REG_MAX); r.base = fora[fora.length - 1].h; }
        await gravarSeguro('registro', r);
      } catch (err) { /* o registro nunca derruba a operação principal */ }
    });
    return filaReg;
  }
  async function verificarRegistro(r) {
    if (!r || !Array.isArray(r.itens) || !r.itens.length) return { ok: true, total: 0 };
    if (!criptoDisponivel()) return { ok: null, total: r.itens.length };
    var ant = r.itens[0].n === 1 ? '' : r.base;
    for (var i = 0; i < r.itens.length; i++) {
      var e = r.itens[i];
      if (i > 0 && e.n !== r.itens[i - 1].n + 1) return { ok: false, total: r.itens.length, problema: 'falta a linha ' + (r.itens[i - 1].n + 1) };
      if (await hashHex(ant + linhaHash(e)) !== e.h) return { ok: false, total: r.itens.length, problema: 'a linha ' + e.n + ' foi alterada' };
      ant = e.h;
    }
    return { ok: ant === r.h, total: r.itens.length, problema: ant === r.h ? null : 'o fim do registro não confere' };
  }
  function resumoValor(v) {
    if (v == null) return ' (apagado)';
    if (Array.isArray(v)) return ' (' + v.length + ' itens)';
    return '';
  }

  /* ---------- validação dos cenários (backup, leitura e gravação) ---------- */
  var V_TIPOS = ['CDB', 'RDB', 'LC', 'LCI', 'LCA', 'LCD', 'CRI', 'CRA', 'DEB', 'DEB_INCENTIVADA', 'TESOURO', 'POUPANCA', 'FUNDO_RF_LP', 'FUNDO_RF_CP'];
  var V_IX = ['CDI', 'CDI_MAIS', 'PRE', 'IPCA', 'SELIC'];
  var V_LIQ = ['diaria', 'carencia', 'vencimento'];
  var CAMPOS_CENARIO = ['id', 'nome', 'valor', 'aporteMensal', 'dataInicio', 'prazoDias', 'premissas', 'duEditado', 'aliqIREditada', 'produtos', 'criadoEm', 'atualizadoEm'];
  var CAMPOS_PRODUTO = ['nome', 'tipo', 'indexador', 'emissor', 'liquidez', 'pctCDI', 'spreadAA', 'taxaAA', 'jurosRealAA', 'carenciaDias', 'custodiaAA', 'taxaAdmAA'];
  var CAMPOS_PREMISSA = ['cdiAA', 'selicAA', 'selicMetaAA', 'trAM', 'ipcaProjAA'];
  /* Marcas que só o próprio site pode dar (exemplo, referência, mercado fixo) nunca vêm de dado do usuário. */
  var MARCAS_INTERNAS = ['exemplo', 'referencia', 'mercadoFixo', '_novo'];
  function limparCenario(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return { c: c, removidas: 0 };
    var n = 0, x = {};
    Object.keys(c).forEach(function (k) { if (MARCAS_INTERNAS.indexOf(k) >= 0) n++; else x[k] = c[k]; });
    return { c: x, removidas: n };
  }
  function dataReal(d) {
    if (typeof d !== 'string' || !/^(19|20|21)\d\d-\d\d-\d\d$/.test(d)) return false;
    var t = new Date(d + 'T00:00:00Z'); return !isNaN(t) && t.toISOString().slice(0, 10) === d;
  }
  function numOk(x, min, max) { return x == null || x === '' || (typeof x === 'number' && isFinite(x) && x >= min && x <= max); }
  function txtOk(x, max) { return x == null || (typeof x === 'string' && x.length <= max); }
  function validarCenario(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return 'cenário em formato inválido';
    var extras = Object.keys(c).filter(function (k) { return CAMPOS_CENARIO.indexOf(k) < 0; });
    if (extras.length) return 'campo desconhecido no cenário (' + extras.slice(0, 3).join(', ').slice(0, 60) + ')';
    if (typeof c.id !== 'string' || !c.id || c.id.length > 100) return 'cenário sem identificador válido';
    if (/^(referencia|ex-)/i.test(c.id)) return 'identificador reservado ao site';
    if (!txtOk(c.nome, 200)) return 'nome do cenário inválido';
    if (!numOk(c.valor, 0, 1e12) || !numOk(c.aporteMensal, 0, 1e10)) return 'valor ou aporte fora da faixa';
    if (c.prazoDias != null && c.prazoDias !== '' && !(Number.isInteger(c.prazoDias) && c.prazoDias >= 1 && c.prazoDias <= 36500)) return 'prazo fora da faixa (1 a 36.500 dias)';
    if (c.dataInicio != null && c.dataInicio !== '' && !dataReal(c.dataInicio)) return 'data de aplicação inválida';
    if (!txtOk(c.criadoEm, 40) || !txtOk(c.atualizadoEm, 40)) return 'data de registro inválida';
    if (!numOk(c.duEditado, 0, 30000) || !numOk(c.aliqIREditada, 0, 1)) return 'premissa editada fora da faixa';
    if (c.premissas != null) {
      if (typeof c.premissas !== 'object' || Array.isArray(c.premissas)) return 'premissas em formato inválido';
      var pk = Object.keys(c.premissas);
      for (var q = 0; q < pk.length; q++) {
        if (CAMPOS_PREMISSA.indexOf(pk[q]) < 0) return 'premissa desconhecida';
        if (!numOk(c.premissas[pk[q]], -1, 2)) return 'premissa fora da faixa';
      }
    }
    if (!Array.isArray(c.produtos) || c.produtos.length > 3) return 'lista de produtos inválida';
    for (var i = 0; i < c.produtos.length; i++) {
      var p = c.produtos[i];
      if (!p || typeof p !== 'object' || Array.isArray(p)) return 'produto em formato inválido';
      if (p.tipo != null && p.tipo !== '' && V_TIPOS.indexOf(p.tipo) < 0) return 'tipo de produto desconhecido';
      if (p.indexador != null && p.indexador !== '' && V_IX.indexOf(p.indexador) < 0) return 'indexador desconhecido';
      if (p.liquidez != null && p.liquidez !== '' && V_LIQ.indexOf(p.liquidez) < 0) return 'liquidez desconhecida';
      var ks = Object.keys(p);
      for (var j = 0; j < ks.length; j++) {
        if (CAMPOS_PRODUTO.indexOf(ks[j]) < 0) return 'campo desconhecido no produto';
        var x = p[ks[j]];
        if (typeof x === 'string' && x.length > 200) return 'texto longo demais no produto';
        if (typeof x === 'number' && (!isFinite(x) || Math.abs(x) > 1e6)) return 'número fora da faixa no produto';
        if (x && typeof x === 'object') return 'campo inesperado no produto';
      }
    }
    return null;
  }
  function validarLista(lista) {
    if (lista == null) return null;
    if (!Array.isArray(lista)) return 'a lista de cenários está em formato inválido';
    if (lista.length > 500) return 'cenários demais (máximo 500)';
    var ids = Object.create(null);
    for (var i = 0; i < lista.length; i++) {
      var e = validarCenario(lista[i]); if (e) return 'cenário ' + (i + 1) + ': ' + e;
      if (ids[lista[i].id]) return 'cenário ' + (i + 1) + ': identificador repetido'; ids[lista[i].id] = true;
    }
    return null;
  }
  /* ---------- validação da carteira (F3): lista fechada de campos por tipo de lançamento ---------- */
  var V_CLASSES = ['ACAO', 'UNIT', 'ETF', 'BDR', 'FII', 'FIAGRO', 'OPCAO', 'DIREITO', 'FIINFRA', 'ETF_RF'];
  var CAMPOS_CARTEIRA = ['versao', 'lancamentos', 'classes', 'cotacoes', 'opcoes', 'irrf', 'darfs'];
  var RE_MES = /^\d{4}-(0[1-9]|1[0-2])$/;   // F4: IRRF da nota e "já paguei", por mês
  var CAMPOS_OPCAO = ['subjacente', 'tipo', 'strike', 'vencimento'];   // cadastro gerencial da opção (F3, Passo B)
  var CAMPOS_LANC_BASE = ['id', 'tipo', 'data', 'ativo', 'seq', 'criadoEm', 'atualizadoEm', 'origem'];
  var CAMPOS_LANC = {
    NEGOCIO: ['lado', 'qtd', 'preco', 'custos', 'corretora'],
    SALDO: ['qtd', 'pm'],
    DESDOBRAMENTO: ['de', 'para'], GRUPAMENTO: ['de', 'para'],
    BONIFICACAO: ['de', 'para', 'custoUnit'],
    DIREITO_RECEBIDO: ['qtd'],
    SUBSCRICAO: ['qtd', 'preco', 'direito'],
    EXPIRACAO: [],
    INCORPORACAO: ['novoAtivo', 'proporcao'],
    LEILAO_FRACAO: ['valor'],
    VENCIMENTO: [],
    EXERCICIO: ['subjacente', 'tipoOpcao', 'strike', 'custos', 'qtd']
  };
  var RE_TICKER = /^[A-Z0-9]{4,12}$/;
  var RE_OPCAO = /^[A-Z][A-Z0-9]{3}[A-X]\d{1,3}[A-Z0-9]?(W[1-5])?$/;   // mesma regra do motor (B3: AAAABCCCWn)
  function ehObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function qtdOk(x) { return Number.isInteger(x) && x >= 1 && x <= 1e9; }
  function valOk(x, min, max) { return typeof x === 'number' && isFinite(x) && x >= min && x <= max; }
  /* Caracteres de controle em texto livre: recusados (sem escapes no código: o build os proíbe). */
  function temControle(t) { for (var i = 0; i < t.length; i++) { var c = t.charCodeAt(i); if (c < 32 || c === 127) return true; } return false; }
  var IDS_RESERVADOS = ['__proto__', 'constructor', 'prototype'];
  function propOk(x) { return valOk(x, 0.0001, 10000); }
  function validarLancamento(l) {
    if (!ehObj(l)) return 'lançamento em formato inválido';
    var tipo = l.tipo == null ? 'NEGOCIO' : l.tipo;
    if (tipo === 'NEGOCIO' && l.tipo != null) return 'tipo de lançamento inválido';
    if (!Object.prototype.hasOwnProperty.call(CAMPOS_LANC, tipo)) return 'tipo de lançamento desconhecido';
    var permitidos = CAMPOS_LANC_BASE.concat(CAMPOS_LANC[tipo]);
    var ks = Object.keys(l);
    for (var i = 0; i < ks.length; i++) {
      if (permitidos.indexOf(ks[i]) < 0) return 'campo desconhecido no lançamento';
      var x = l[ks[i]];
      if (x && typeof x === 'object') return 'campo inesperado no lançamento';
      if (typeof x === 'string' && x.length > 100) return 'texto longo demais no lançamento';
      if (typeof x === 'string' && temControle(x)) return 'caractere de controle no lançamento';
    }
    if (typeof l.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(l.id) || IDS_RESERVADOS.indexOf(l.id) >= 0) return 'lançamento sem identificador válido';
    if (!dataReal(l.data)) return 'data inválida no lançamento';
    if (typeof l.ativo !== 'string' || !RE_TICKER.test(l.ativo)) return 'código de ativo inválido';
    if (l.seq != null && !(Number.isInteger(l.seq) && l.seq >= 0 && l.seq <= 1e12)) return 'ordem do lançamento inválida';
    if (!txtOk(l.criadoEm, 40) || !txtOk(l.atualizadoEm, 40) || !txtOk(l.origem, 20)) return 'registro do lançamento inválido';
    switch (tipo) {
      case 'NEGOCIO':
        if (l.lado !== 'C' && l.lado !== 'V') return 'compra ou venda não informada';
        if (!qtdOk(l.qtd)) return 'quantidade inválida';
        if (!valOk(l.preco, 0.000001, 1e7)) return 'preço inválido';
        if (!valOk(l.custos, 0, 1e7)) return 'custos da nota não informados (digite 0 se não houve)';
        if (!txtOk(l.corretora, 40)) return 'corretora inválida';
        break;
      case 'SALDO':
        if (!qtdOk(l.qtd)) return 'quantidade inválida';
        if (l.pm != null && !valOk(l.pm, 0, 1e7)) return 'preço médio inválido';
        break;
      case 'DESDOBRAMENTO': case 'GRUPAMENTO': case 'BONIFICACAO':
        if (!valOk(l.de, 0.000001, 1e6) || !valOk(l.para, 0.000001, 1e6) || !propOk(l.para / l.de)) return 'proporção do evento inválida';
        if (tipo === 'DESDOBRAMENTO' && !(l.para > l.de)) return 'no desdobramento a quantidade aumenta (ex.: 1 para 2)';
        if (tipo === 'GRUPAMENTO' && !(l.para < l.de)) return 'no grupamento a quantidade diminui (ex.: 10 para 1)';
        if (tipo === 'BONIFICACAO' && l.custoUnit != null && !valOk(l.custoUnit, 0, 1e7)) return 'custo atribuído inválido';
        break;
      case 'DIREITO_RECEBIDO':
        if (!qtdOk(l.qtd)) return 'quantidade inválida';
        break;
      case 'SUBSCRICAO':
        if (!qtdOk(l.qtd) || !valOk(l.preco, 0, 1e7)) return 'quantidade ou preço da subscrição inválido';
        if (l.direito != null && !(typeof l.direito === 'string' && RE_TICKER.test(l.direito))) return 'código do direito inválido';
        break;
      case 'INCORPORACAO':
        if (typeof l.novoAtivo !== 'string' || !RE_TICKER.test(l.novoAtivo)) return 'código do novo ativo inválido';
        if (!propOk(l.proporcao)) return 'proporção inválida';
        break;
      case 'LEILAO_FRACAO':
        if (!valOk(l.valor, 0, 1e9)) return 'valor do leilão inválido';
        break;
      case 'VENCIMENTO':
        if (!RE_OPCAO.test(l.ativo)) return 'vencimento só vale para código de opção';
        break;
      case 'EXERCICIO':
        if (!RE_OPCAO.test(l.ativo)) return 'exercício só vale para código de opção';
        if (typeof l.subjacente !== 'string' || !RE_TICKER.test(l.subjacente) || RE_OPCAO.test(l.subjacente)) return 'código do ativo-objeto inválido';
        if (l.tipoOpcao !== 'CALL' && l.tipoOpcao !== 'PUT') return 'tipo de opção inválido';
        if (!valOk(l.strike, 0.0001, 1e7) || (l.custos != null && !valOk(l.custos, 0, 1e7))) return 'strike ou custos inválidos';
        if (l.qtd != null && !qtdOk(l.qtd)) return 'quantidade exercida inválida';
        break;
    }
    return null;
  }
  function validarCarteira(c) {
    if (c == null) return null;
    if (!ehObj(c)) return 'carteira em formato inválido';
    var ks = Object.keys(c);
    for (var i = 0; i < ks.length; i++) if (CAMPOS_CARTEIRA.indexOf(ks[i]) < 0) return 'campo desconhecido na carteira';
    if (c.versao !== 1) return 'versão da carteira desconhecida';
    if (!Array.isArray(c.lancamentos) || c.lancamentos.length > 20000) return 'lista de lançamentos inválida';
    var ids = Object.create(null);
    for (var j = 0; j < c.lancamentos.length; j++) {
      var e = validarLancamento(c.lancamentos[j]); if (e) return 'lançamento ' + (j + 1) + ': ' + e;
      if (ids[c.lancamentos[j].id]) return 'lançamento ' + (j + 1) + ': identificador repetido'; ids[c.lancamentos[j].id] = true;
    }
    if (c.classes != null) {
      if (!ehObj(c.classes)) return 'classificação em formato inválido';
      var cs = Object.keys(c.classes); if (cs.length > 5000) return 'classificações demais';
      for (var k = 0; k < cs.length; k++) if (!RE_TICKER.test(cs[k]) || V_CLASSES.indexOf(c.classes[cs[k]]) < 0) return 'classificação inválida';
    }
    if (c.opcoes != null) {
      if (!ehObj(c.opcoes)) return 'cadastro de opções em formato inválido';
      var os = Object.keys(c.opcoes); if (os.length > 5000) return 'opções demais no cadastro';
      for (var o = 0; o < os.length; o++) {
        var op = c.opcoes[os[o]];
        if (!RE_OPCAO.test(os[o]) || !ehObj(op)) return 'cadastro de opção inválido';
        var ok2 = Object.keys(op);
        for (var z = 0; z < ok2.length; z++) if (CAMPOS_OPCAO.indexOf(ok2[z]) < 0) return 'campo desconhecido no cadastro da opção';
        if (typeof op.subjacente !== 'string' || !RE_TICKER.test(op.subjacente) || RE_OPCAO.test(op.subjacente)) return 'ativo-objeto da opção inválido';
        if (op.tipo !== 'CALL' && op.tipo !== 'PUT') return 'tipo da opção inválido';
        if (!valOk(op.strike, 0.0001, 1e7)) return 'strike da opção inválido';
        if (!dataReal(op.vencimento)) return 'vencimento da opção inválido';
      }
    }
    if (c.irrf != null) {
      if (!ehObj(c.irrf)) return 'IRRF em formato inválido';
      var ms = Object.keys(c.irrf); if (ms.length > 1200) return 'meses demais no IRRF';
      for (var n = 0; n < ms.length; n++) {
        var iv = c.irrf[ms[n]];
        if (!RE_MES.test(ms[n]) || !ehObj(iv)) return 'IRRF inválido';
        var ic = Object.keys(iv);
        for (var y = 0; y < ic.length; y++) if (['COMUM', 'DAYTRADE', 'FII'].indexOf(ic[y]) < 0 || !valOk(iv[ic[y]], 0, 1e9)) return 'IRRF inválido';
      }
    }
    if (c.darfs != null) {
      if (!ehObj(c.darfs)) return 'pagamentos de DARF em formato inválido';
      var ds = Object.keys(c.darfs); if (ds.length > 1200) return 'pagamentos de DARF demais';
      for (var h = 0; h < ds.length; h++) {
        var pg = c.darfs[ds[h]];
        if (!RE_MES.test(ds[h]) || !ehObj(pg)) return 'pagamento de DARF inválido';
        var pk = Object.keys(pg);
        for (var u = 0; u < pk.length; u++) if (['pagoEm', 'valor'].indexOf(pk[u]) < 0) return 'campo desconhecido no pagamento de DARF';
        if (!dataReal(pg.pagoEm) || !valOk(pg.valor, 0.01, 1e9)) return 'pagamento de DARF inválido';
      }
    }
    if (c.cotacoes != null) {
      if (!ehObj(c.cotacoes)) return 'cotações em formato inválido';
      var qs = Object.keys(c.cotacoes); if (qs.length > 5000) return 'cotações demais';
      for (var q = 0; q < qs.length; q++) {
        var v = c.cotacoes[qs[q]];
        if (!RE_TICKER.test(qs[q]) || !ehObj(v)) return 'cotação inválida';
        var vk = Object.keys(v);
        for (var w = 0; w < vk.length; w++) if (['valor', 'fonte', 'em'].indexOf(vk[w]) < 0) return 'campo desconhecido na cotação';
        if (!valOk(v.valor, 0.000001, 1e7) || !txtOk(v.fonte, 80) || (typeof v.fonte === 'string' && temControle(v.fonte)) || typeof v.em !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(v.em) || !dataReal(v.em.slice(0, 10)) || v.em < '2000-01-01' || v.em > '2100-01-01') return 'cotação inválida';
      }
    }
    return null;
  }
  /* F5: proventos e aluguel, por lista fechada de campos (mesmas defesas da carteira). */
  var CAMPOS_ITEM_BASE = ['id', 'tipo', 'ativo', 'pagamento', 'irrf', 'fonte', 'criadoEm', 'atualizadoEm'];
  var CAMPOS_ITEM = { DIVIDENDO: ['dataCom', 'qtd', 'valorUnit', 'origem'], JCP: ['dataCom', 'qtd', 'valorUnit', 'origem'], RENDIMENTO_FII: ['dataCom', 'qtd', 'valorUnit', 'origem'], ALUGUEL: ['inicio', 'bruto', 'custos'] };
  function dataFaixa(d) { return dataReal(d) && d >= '2000-01-01' && d <= '2100-12-31'; }
  function validarItemProvento(it) {
    if (!ehObj(it)) return 'item em formato inválido';
    if (typeof it.tipo !== 'string' || !Object.prototype.hasOwnProperty.call(CAMPOS_ITEM, it.tipo)) return 'tipo de rendimento desconhecido';
    var permitidos = CAMPOS_ITEM_BASE.concat(CAMPOS_ITEM[it.tipo]), ks = Object.keys(it);
    for (var i = 0; i < ks.length; i++) {
      if (permitidos.indexOf(ks[i]) < 0) return 'campo desconhecido no rendimento';
      var x = it[ks[i]];
      if (x && typeof x === 'object') return 'campo inesperado no rendimento';
      if (typeof x === 'string' && (x.length > 100 || temControle(x))) return 'texto inválido no rendimento';
    }
    if (typeof it.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(it.id) || IDS_RESERVADOS.indexOf(it.id) >= 0) return 'rendimento sem identificador válido';
    if (typeof it.ativo !== 'string' || !RE_TICKER.test(it.ativo) || RE_OPCAO.test(it.ativo)) return 'código de ativo inválido (opção não paga provento)';
    if (it.pagamento != null && !dataFaixa(it.pagamento)) return 'data de pagamento inválida';
    if (it.irrf != null && !valOk(it.irrf, 0, 1e9)) return 'IR retido inválido';
    if (!txtOk(it.fonte, 80)) return 'fonte longa demais';
    if (!txtOk(it.criadoEm, 40) || !txtOk(it.atualizadoEm, 40)) return 'registro do rendimento inválido';
    if (it.tipo === 'ALUGUEL') {
      if (!dataFaixa(it.pagamento)) return 'informe a data do crédito do aluguel';
      if (it.inicio != null && (!dataFaixa(it.inicio) || it.inicio > it.pagamento)) return 'o início do contrato tem de ser uma data até a do crédito';
      if (!valOk(it.bruto, 0.01, 1e9)) return 'remuneração bruta inválida';
      if (it.custos != null && !valOk(it.custos, 0, 1e7)) return 'taxa da corretora inválida';
      if ((it.irrf || 0) + (it.custos || 0) > it.bruto) return 'IR e taxa maiores que a remuneração bruta';
      return null;
    }
    if (!dataFaixa(it.dataCom)) return 'data-com inválida';
    if (it.pagamento != null && it.pagamento < it.dataCom) return 'o pagamento não pode vir antes da data-com';
    if (!qtdOk(it.qtd)) return 'quantidade inválida';
    if (!valOk(it.valorUnit, 0.00000001, 1e6)) return 'valor por ação inválido';
    if (it.origem !== 'COMPANHIA' && it.origem !== 'REEMBOLSO') return 'origem do provento inválida';
    if (it.origem === 'REEMBOLSO' && it.tipo === 'RENDIMENTO_FII') return 'o reembolso do aluguel vale para dividendo e JCP de ações';
    if (it.irrf != null && it.irrf > it.qtd * it.valorUnit + 0.01) return 'IR retido maior que o valor bruto';
    return null;
  }
  function validarProventos(p) {
    if (p == null) return null;
    if (!ehObj(p)) return 'proventos em formato inválido';
    var ks = Object.keys(p);
    for (var i = 0; i < ks.length; i++) if (['versao', 'itens'].indexOf(ks[i]) < 0) return 'campo desconhecido em proventos';
    if (p.versao !== 1) return 'versão de proventos desconhecida';
    if (!Array.isArray(p.itens) || p.itens.length > 20000) return 'lista de proventos inválida';
    var ids = Object.create(null);
    for (var j = 0; j < p.itens.length; j++) {
      var e = validarItemProvento(p.itens[j]); if (e) return 'rendimento ' + (j + 1) + ': ' + e;
      if (ids[p.itens[j].id]) return 'rendimento ' + (j + 1) + ': identificador repetido'; ids[p.itens[j].id] = true;
    }
    return null;
  }
  /* Seções ainda sem tela (config, radar): só aceitam vazio até a fase que as usa. */
  function validarChave(k, v) {
    if (k === 'cenarios') return validarLista(v);
    if (k === 'carteira') return validarCarteira(v);
    if (k === 'proventos') return validarProventos(v);
    if (v != null) return 'seção "' + k + '" ainda não é usada pelo site';
    return null;
  }

  /* Separa os cenários válidos dos inválidos (estes vão para a quarentena, cifrada). Remove marcas internas. */
  function separarCenarios(lista) {
    var bons = [], ruins = [], marcas = 0, ids = Object.create(null);
    lista.forEach(function (c) {
      var l = limparCenario(c); marcas += l.removidas;
      var e = validarCenario(l.c) || (l.c && ids[l.c.id] ? 'identificador repetido' : null);
      if (e) ruins.push({ cenario: c, motivo: e }); else { ids[l.c.id] = true; bons.push(l.c); }
    });
    return { bons: bons, ruins: ruins, marcas: marcas };
  }
  /* Área separada (quarentena): o que não pôde ser aberto ou foi descartado. Nunca expulsa itens; não duplica
     (cada item tem o SHA-256 do conteúdo); só considera guardado depois de reler do disco. */
  var QUARENTENA_MAX = 1000;
  var invalidosPendentes = {};   // cenários inválidos que não couberam na área separada: continuam guardados junto da lista
  async function lerQuarentena() {
    var q = await lerSeguro('quarentena');   // ilegível → erro (não sobrescreve)
    return Array.isArray(q) ? q : [];
  }
  async function guardarQuarentena(itens) {
    var q, vistos = {};
    try { q = await lerQuarentena(); }
    catch (e) {
      // Área separada ilegível: o conteúdo bruto vira o primeiro item da nova área (nada se perde, nada trava).
      var bruto = await Armazenamento.ler('quarentena'), tb = JSON.stringify(bruto);
      q = [{ em: new Date().toISOString(), motivo: 'área separada anterior estava ilegível (alterada fora do site?); conteúdo bruto preservado', h: (await hashHex(tb)) || tb, valor: bruto }];
      alerta('a área separada estava ilegível; o conteúdo bruto foi preservado como um item da nova área');
    }
    q.forEach(function (x) { if (x && x.h) vistos[x.h] = true; });
    var novos = 0;
    for (var i = 0; i < itens.length; i++) {
      var x = itens[i], valor = x.valor !== undefined ? x.valor : x.cenario, txt = JSON.stringify(valor === undefined ? null : valor);
      var h = (await hashHex(txt)) || txt;
      if (vistos[h]) continue;
      vistos[h] = true; novos++;
      q.push({ em: new Date().toISOString(), motivo: x.motivo, h: h, valor: valor === undefined ? null : valor });
    }
    if (!novos) return 0;
    if (q.length > QUARENTENA_MAX) throw new Error('a área separada passaria de ' + QUARENTENA_MAX + ' itens: baixe uma cópia e apague-a em Dados e backup');
    await gravarSeguro('quarentena', q);
    var lido = await lerQuarentena();
    if (lido.length !== q.length) throw new Error('a cópia na área separada não pôde ser conferida');
    return novos;
  }
  function anunciarIlegivel(k) { try { document.dispatchEvent(new CustomEvent('cf:ilegivel', { detail: k })); } catch (e) {} }

  /* Versão lida por esta aba (texto do valor bruto guardado): uma gravação comum só acontece se o guardado ainda for o
     que esta aba leu ou gravou. Outra aba que gravou antes → recusa, em vez de apagar o lançamento dela (7ª revisão, N3/N9). */
  var versaoLida = Object.create(null);
  function textoBruto(b) { return JSON.stringify(b === undefined ? null : b); }
  var Porta = {
    ler: async function (k) {
      await pronto;
      var v, bruto;
      // Lê o bruto antes do conteúdo: se outra aba gravar no meio, a versão anotada é a antiga e a próxima gravação é recusada (lado seguro).
      try { bruto = await Armazenamento.ler(k); } catch (e) { bruto = undefined; }
      try { v = await lerSeguro(k); }
      catch (e) { ilegivel[k] = true; anunciarIlegivel(k); throw e; }
      if (k === 'cenarios' && v != null) {
        if (!Array.isArray(v)) {
          ilegivel[k] = true; alerta('a lista de cenários guardada está em formato inválido; não foi aberta nem será sobrescrita'); anunciarIlegivel(k);
          throw new Error('cenários em formato inválido');
        }
        var sep = separarCenarios(v);
        invalidosPendentes[k] = [];
        if (sep.ruins.length) {
          var guardou = false;
          try { await guardarQuarentena(sep.ruins); guardou = true; }
          catch (e) {
            // Não coube na área separada: os válidos abrem normalmente e os inválidos continuam guardados na própria
            // lista (cada gravação os mantém). Nada é marcado como ilegível nem se perde.
            invalidosPendentes[k] = sep.ruins.map(function (r) { return r.cenario; });
            alerta(sep.ruins.length + ' cenário(s) com formato inválido não puderam ir para a área separada (' + e.message + '); continuam guardados como estão e os demais abriram normalmente');
          }
          if (guardou) {
            // Separados e conferidos: regrava só os válidos, desde que a lista guardada não tenha mudado nesse meio-tempo.
            var original = JSON.stringify(v);
            try {
              await comTrava('exclusive', async function () {
                var atual = await lerSeguro(k);
                if (JSON.stringify(atual) !== original) return;
                if (cofre.chave) await conferirMetaGuardada();
                var novoBruto = cofre.chave ? await cifrarValor(k, sep.bons) : sep.bons;
                await Armazenamento.gravar(k, novoBruto);
                if (versaoLida[k] === textoBruto(bruto)) bruto = novoBruto;
              });
              registrar('gravacao', k + resumoValor(sep.bons) + ' (inválidos movidos para a área separada)');
            } catch (e) {}
            alerta(sep.ruins.length + ' cenário(s) com formato inválido (' + sep.ruins[0].motivo + ') foram movidos para a área separada (Dados e backup); os demais abriram normalmente');
          }
        }
        if (sep.marcas) alerta('marcas internas (exemplo, referência ou mercado fixo) encontradas em cenários seus foram removidas');
        v = sep.bons;
      }
      if (k !== 'cenarios' && v != null) {
        // Carteira e seções sem tela: conteúdo fora do formato não é aberto nem sobrescrito (só por "Descartar os ilegíveis" ou backup).
        var ev = validarChave(k, v);
        if (ev) {
          ilegivel[k] = true; alerta('os dados guardados de "' + k + '" estão fora do formato esperado (' + ev + '); não foram abertos nem serão sobrescritos'); anunciarIlegivel(k);
          throw new Error('dados de "' + k + '" fora do formato');
        }
      }
      versaoLida[k] = textoBruto(bruto);
      if (!lidasNaSessao[k]) { lidasNaSessao[k] = true; registrar('leitura', k); }
      return v;
    },
    /* substituir = o usuário pediu explicitamente para trocar o conteúdo (importar backup, descartar ilegível). */
    gravar: async function (k, v, substituir) {
      await pronto;
      if (cofre.travando) throw new Error('o site está travando');
      if (bloqueioGravacao) throw new Error(bloqueioGravacao);
      if (ilegivel[k] && !substituir) throw new Error('os dados guardados de "' + k + '" não puderam ser lidos; para não apagá-los, nada foi gravado por cima. Use "Descartar os ilegíveis" no aviso do topo ou importe um backup');
      v = copia(v);   // valida e grava a mesma cópia (7ª revisão, N6)
      var erro = validarChave(k, v); if (erro) throw new Error(erro);
      // Inválidos que não couberam na área separada continuam junto da lista (nunca somem numa gravação comum).
      var guardar = (!substituir && Array.isArray(v) && invalidosPendentes[k] && invalidosPendentes[k].length) ? v.concat(invalidosPendentes[k]) : v;
      var conferir = (!substituir && versaoLida[k] !== undefined) ? async function () {
        if (textoBruto(await Armazenamento.ler(k)) !== versaoLida[k]) {
          alerta('os dados de "' + k + '" foram alterados em outra aba ou janela; a gravação desta aba foi recusada para não apagar o que foi feito lá');
          throw new Error('os dados de "' + k + '" foram alterados em outra aba ou janela; recarregue a página (F5) para ver a versão atual e lance de novo');
        }
      } : null;
      var gravado = await gravarSeguro(k, guardar, conferir);
      versaoLida[k] = textoBruto(gravado);
      if (substituir) invalidosPendentes[k] = [];
      ilegivel[k] = false;
      registrar('gravacao', k + resumoValor(v));
      return true;
    },
    /* Guarda o conteúdo ilegível na quarentena e libera a chave para uso. */
    descartarIlegivel: async function (k) {
      await pronto;
      if (!ilegivel[k]) return false;
      var bruto = await Armazenamento.ler(k);
      await guardarQuarentena([{ motivo: 'conteúdo ilegível de "' + k + '" descartado pelo usuário', valor: bruto }]);   // relê e confere antes de seguir
      await comTrava('shared', function () { return Armazenamento.gravar(k, null); });
      ilegivel[k] = false; versaoLida[k] = textoBruto(null);
      registrar('alerta', 'conteúdo ilegível de "' + k + '" descartado pelo usuário (cópia guardada na quarentena)');
      return true;
    }
  };
  /* Dados auxiliares (mercado, data do último backup): no cofre quando ele existe; sem cofre, no navegador. */
  async function lerAux(k) {
    await carregado;
    if (cofre.meta) { await pronto; try { return await lerSeguro(k); } catch (e) { return null; } }
    return Local.ler(k);
  }
  async function gravarAux(k, v) {
    await carregado;
    if (cofre.meta) { await pronto; return gravarSeguro(k, v); }
    return Local.gravar(k, v);
  }

  /* ---------- troca de configuração em duas fases: prepara, confere, vira ---------- */
  var NULO = { __nulo: 1 };
  async function limparPreparo(ks) {
    for (var i = 0; i < ks.length; i++) { try { await Armazenamento.gravar('novo_' + ks[i], null); } catch (e) {} }
    try { await Armazenamento.gravar('cofreNovo', null); } catch (e) {}
  }
  /* A prova autentica também o conteúdo preparado (SHA-256 de cada novo_*): trocar os valores invalida o plano. */
  function corpoPlano(p) { return JSON.stringify({ meta: p.meta || null, chaves: p.chaves, em: p.em, tipo: p.tipo || '', hashes: p.hashes || null, id: p.id || '' }); }
  function planoValido(p) {
    return !!(p && Array.isArray(p.chaves) && p.chaves.length <= CHAVES_COFRE.length && typeof p.em === 'string' &&
      p.chaves.every(function (k) { return CHAVES_COFRE.indexOf(k) >= 0; }) && (p.meta === null || metaValida(p.meta)) &&
      p.hashes && typeof p.hashes === 'object' && p.chaves.every(function (k) { return typeof p.hashes[k] === 'string'; }));
  }
  async function conferirPreparo(p) {
    for (var i = 0; i < p.chaves.length; i++) {
      var txt = JSON.stringify(await Armazenamento.ler('novo_' + p.chaves[i]));
      if (((await hashHex(txt)) || txt) !== p.hashes[p.chaves[i]]) return false;
    }
    return true;
  }
  async function provaConfere(prova, chave, p) {
    if (!ehCifrado(prova) || !chave) return false;
    try { return (await decifrarValor('cofreNovo', prova, chave)) === corpoPlano(p); } catch (e) { return false; }
  }
  /* Executa um plano JÁ VERIFICADO (nunca chamado na abertura antes da senha, quando há cofre). */
  async function virar(plano) {
    if (!plano || !Array.isArray(plano.chaves)) return false;
    if (!planoValido(plano) || !(await conferirPreparo(plano))) throw new Error('o conteúdo preparado não confere com o plano');
    for (var i = 0; i < plano.chaves.length; i++) {
      var k = plano.chaves[i];
      if (CHAVES_COFRE.indexOf(k) < 0) continue;
      var v = await Armazenamento.ler('novo_' + k);
      if (v == null) throw new Error('preparo incompleto de "' + k + '"');
      await Armazenamento.gravar(k, v.__nulo ? null : v);
    }
    await Armazenamento.gravar('cofre', plano.meta || null);
    await Armazenamento.gravar('cofreReserva', plano.meta || null);
    await limparPreparo(plano.chaves);
    return true;
  }
  /* Duas fases: prepara (novo_*), confere, grava o plano com prova autenticada e só então vira.
     chaveAntiga = chave em vigor (prova que quem pediu sabia a senha atual); chaveNova = chave de metaFinal. */
  var ERRO_PENDENTE = 'pendente';
  /* A virada grava cada chave com o novo_* ainda guardado: precisa caber o conteúdo novo duas vezes. Testa antes de gravar o plano,
     porque uma virada sem espaço apagaria dados e deixaria o plano pendente para sempre (revisão independente da v0.12.0). */
  var FOLGA_PLANO = 32768;
  function garantirFolga(valores, ks) {
    if (Armazenamento !== Local) return;
    var falta = FOLGA_PLANO;
    for (var i = 0; i < ks.length; i++) {
      var novo = valores[ks[i]] == null ? 0 : JSON.stringify(valores[ks[i]]).length;
      var atual = (localStorage.getItem(PREFIXO + ks[i]) || '').length;
      if (novo > atual) falta += novo - atual;
    }
    try { localStorage.setItem(PREFIXO + 'novo_folga', 'x'.repeat(falta)); }
    catch (e) { throw new Error('espaço insuficiente neste navegador para esta operação'); }
    finally { try { localStorage.removeItem(PREFIXO + 'novo_folga'); } catch (e2) {} }
  }
  async function migrar(valores, metaFinal, tipo, chaveAntiga, chaveNova) {
    var ks = Object.keys(valores);
    var plano = { meta: metaFinal || null, chaves: ks, em: new Date().toISOString(), tipo: tipo, hashes: {}, id: paraB64(root.crypto.getRandomValues(new Uint8Array(12))) };
    try {
      for (var i = 0; i < ks.length; i++) await Armazenamento.gravar('novo_' + ks[i], valores[ks[i]] == null ? NULO : valores[ks[i]]);
      for (var j = 0; j < ks.length; j++) {
        var lido = await Armazenamento.ler('novo_' + ks[j]), esperado = JSON.stringify(valores[ks[j]] == null ? NULO : valores[ks[j]]);
        if (JSON.stringify(lido) !== esperado) throw new Error('a conferência da gravação falhou');
        plano.hashes[ks[j]] = (await hashHex(esperado)) || esperado;
      }
      garantirFolga(valores, ks);
      plano.provaAntiga = chaveAntiga ? await cifrarValor('cofreNovo', corpoPlano(plano), chaveAntiga) : null;
      plano.provaNova = chaveNova ? await cifrarValor('cofreNovo', corpoPlano(plano), chaveNova) : null;
      await Armazenamento.gravar('cofreNovo', plano);
    } catch (e) {
      await limparPreparo(ks);
      throw new Error('não houve espaço ou permissão para gravar com segurança; nada foi alterado (' + e.message + ')');
    }
    try { await virar(plano); }
    catch (e1) {
      try { await virar(plano); }
      catch (e2) { var er = new Error('a operação ficou gravada pela metade e será concluída na próxima vez que você abrir o site'); er.codigo = ERRO_PENDENTE; throw er; }
    }
    // Criar, trocar ou remover a senha só recifra o mesmo conteúdo: esta aba continua "em dia" com o que leu.
    // Importar backup não: a tela precisa reler (cf:dados-restaurados), e uma gravação com a versão antiga é recusada.
    if (tipo !== 'restaurar') for (var v2 = 0; v2 < ks.length; v2++) if (versaoLida[ks[v2]] !== undefined) versaoLida[ks[v2]] = textoBruto(await Armazenamento.ler(ks[v2]));
    registrar('plano-concluido', plano.id);
  }
  async function planoJaVirou(p) {
    if (!p.meta || (p.tipo !== 'trocar' && p.tipo !== 'criar')) return false;
    var g1 = await Armazenamento.ler('cofre'), g2 = await Armazenamento.ler('cofreReserva');
    return [g1, g2].some(function (g) { return metaValida(g) && g.sal === p.meta.sal; }) && !!(cofre.meta && cofre.meta.sal === p.meta.sal);
  }
  async function planoJaConcluido(p, chave) {
    if (!p.id) return false;
    try {
      var raw = await Armazenamento.ler('registro');
      if (!ehCifrado(raw)) return false;
      var r = await decifrarValor('registro', raw, chave);
      if (r && Array.isArray(r.concluidos) && r.concluidos.indexOf(p.id) >= 0) return true;
      return !!(r && Array.isArray(r.itens) && r.itens.some(function (e) { return e.tipo === 'plano-concluido' && typeof e.detalhe === 'string' && e.detalhe.indexOf(p.id) === 0; }));
    } catch (e) { return false; }
  }
  async function exclusivo(fn) {
    if (ocupado) throw new Error('outra operação de senha está em andamento');
    ocupado = true;
    try { return await fn(); } finally { ocupado = false; }
  }

  async function derivarDoCofre(senha, meta) { return derivarChave(senha, deB64(meta.sal), meta.iteracoes); }
  async function conferirSenha(senha, meta) {
    var chave = await derivarDoCofre(senha, meta);
    var v = await decifrarValor('verificador', meta.verificador, chave); // erro = senha errada
    if (v !== 'controle-financeiro') throw new Error('verificador inválido');
    return chave;
  }
  /* Lê tudo para recifrar. Dado ilegível não bloqueia a troca: o conteúdo bruto vai para a área separada (preservado). */
  async function lerTudoAberto() {
    var o = {}, ilegiveis = [];
    for (var i = 0; i < CHAVES_COFRE.length; i++) {
      var k = CHAVES_COFRE[i];
      try { o[k] = await lerSeguro(k); }
      catch (e) { o[k] = null; ilegiveis.push({ k: k, bruto: await Armazenamento.ler(k) }); }
    }
    if (ilegiveis.length) {
      if (!Array.isArray(o.quarentena)) o.quarentena = [];
      for (var j = 0; j < ilegiveis.length; j++) {
        var txt = JSON.stringify(ilegiveis[j].bruto);
        o.quarentena.push({ em: new Date().toISOString(), motivo: 'conteúdo ilegível de "' + ilegiveis[j].k + '" preservado na troca de senha', h: (await hashHex(txt)) || txt, valor: ilegiveis[j].bruto });
      }
      ilegiveis.forEach(function (x) { alerta('o conteúdo ilegível de "' + x.k + '" foi preservado na área separada durante a operação de senha'); });
    }
    return o;
  }
  async function novaMeta(senha, base) {
    var sal = root.crypto.getRandomValues(new Uint8Array(16));
    var meta = Object.assign({ versao: 1, alg: CRIPTO.alg, kdf: CRIPTO.kdf, iteracoes: CRIPTO.iteracoes, sal: paraB64(sal) }, base || {});
    var chave = await derivarChave(senha, sal, meta.iteracoes);
    meta.verificador = await cifrarValor('verificador', 'controle-financeiro', chave);
    return { meta: meta, chave: chave };
  }
  async function cifrarTudo(aberto, chave) {
    var o = {}, ks = Object.keys(aberto);
    for (var i = 0; i < ks.length; i++) o[ks[i]] = aberto[ks[i]] == null ? null : await cifrarValor(ks[i], aberto[ks[i]], chave);
    return o;
  }

  /* Senha nova: mínimo de 12 caracteres e nada de padrões óbvios (a força da senha é a defesa contra quem copia o arquivo). */
  var SENHAS_COMUNS = ['controlefinanceiro', 'comparadorrendafixa', 'iloveyou', 'password', 'passwd', 'senha', 'admin', 'administrador', 'brasil', 'mudar', 'qwerty', 'abcdef',
    'letmein', 'welcome', 'bemvindo', 'monkey', 'dragon', 'football', 'futebol', 'flamengo', 'mengao', 'corinthians', 'timao', 'palmeiras', 'verdao', 'saopaulo', 'santos', 'vasco',
    'gremio', 'cruzeiro', 'botafogo', 'fluminense', 'internacional', 'atletico', 'bahia', 'amor', 'deus', 'jesus', 'cristo', 'familia', 'teamo', 'princesa', 'princess',
    'master', 'sunshine', 'trustno', 'batman', 'superman', 'pokemon', 'naruto', 'starwars', 'teste', 'test', 'senhasegura', 'segredo', 'secret', 'acesso', 'login',
    'usuario', 'user', 'root', 'shadow', 'hello', 'ola', 'freedom', 'whatever', 'qazwsx', 'michael', 'charlie', 'jordan', 'hunter', 'ranger', 'buster', 'soccer',
    'baseball', 'killer', 'pepper', 'ginger', 'summer', 'winter', 'flower', 'lovely', 'banana', 'chocolate', 'cookie', 'computador', 'internet', 'google', 'facebook',
    'linkedin', 'github', 'microsoft', 'windows', 'apple', 'samsung', 'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro',
    'outubro', 'novembro', 'dezembro', 'gabriel', 'leonardo', 'leo', 'lucas', 'pedro', 'joao', 'maria', 'ana', 'julia', 'mateus', 'matheus', 'rafael', 'gustavo',
    'felipe', 'bruno', 'carlos', 'paulo', 'marcos', 'rodrigo', 'fernando', 'ricardo', 'daniel', 'eduardo', 'andre', 'thiago', 'tiago', 'vinicius', 'guilherme',
    'beatriz', 'mariana', 'fernanda', 'camila', 'amanda', 'bruna', 'larissa', 'leticia', 'gabriela', 'juliana', 'patricia', 'aline', 'jessica', 'vitoria', 'luiza',
    'curti', 'alianca', 'rico', 'investimento', 'dinheiro', 'money', 'bitcoin'];
  var LEET = { '@': 'a', '4': 'a', '3': 'e', '0': 'o', '1': 'i', '!': 'i', '$': 's', '5': 's', '7': 't', '8': 'b', '9': 'g' };
  /* Reduz a senha ao "núcleo": tira repetições de blocos, dígitos e sequências de teclado para ver se sobra algo próprio. */
  /* Tira sequências de 3+ caracteres seguidos (abc, 321, qwe, asd, zxc...). */
  function tirarSequencias(x) {
    var linhas = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'abcdefghijklmnopqrstuvwxyz', 'qazwsxedcrfvtgbyhnujmikolp', 'qweasdzxc', 'zaqxswcdevfrbgtnhymjukilop'];
    var marca = new Array(x.length).fill(false);
    for (var i = 0; i + 2 < x.length; i++) {
      for (var n = x.length - i; n >= 3; n--) {
        var pedaco = x.slice(i, i + n), inv = pedaco.split('').reverse().join('');
        if (linhas.some(function (l) { return l.indexOf(pedaco) >= 0 || l.indexOf(inv) >= 0; })) { for (var j = i; j < i + n; j++) marca[j] = true; break; }
      }
    }
    return x.split('').filter(function (c, i) { return !marca[i]; }).join('');
  }
  function blocoRepetido(x) {
    for (var n = 1; n <= x.length / 2; n++) { var b = x.slice(0, n); if (b.repeat(Math.ceil(x.length / n)).slice(0, x.length) === x) return true; }
    return false;
  }
  function letrasENumeros(t) {
    return t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
  }
  function nucleo(x) {
    // Ordem: tira dígitos, depois sequências de teclado/alfabeto, depois palavras e nomes comuns.
    function semPalavras(y) { SENHAS_COMUNS.forEach(function (w) { y = y.split(w).join(''); }); return y; }
    var semDigitos = x.replace(/\p{N}+/gu, '');
    // As duas ordens (palavras antes ou depois das sequências); vale a que sobrar menos.
    var a = semPalavras(tirarSequencias(semDigitos)), b = tirarSequencias(semPalavras(semDigitos));
    return Array.from(a).length <= Array.from(b).length ? a : b;
  }
  function nucleoFraco(t) {
    var x = letrasENumeros(t);
    if (/^\p{N}+$/u.test(x)) return true;                                                 // só números
    if (blocoRepetido(x)) return true;                                                     // bloco repetido
    // Teclado intercalado com números (1q2w3e, a1s2d3): tira os números antes das sequências.
    var a = nucleo(x);
    // Troca de letras por símbolos ou números (P@ssw0rd, Fl@meng0): normaliza e analisa de novo.
    var b = nucleo(letrasENumeros(t.split('').map(function (c) { return LEET[c] || c; }).join('')));
    function fraco(n) { return Array.from(n).length < 4 || blocoRepetido(n); }
    return fraco(a) || fraco(b);
  }
  function validarSenhaNova(s) {
    s = String(s || '');
    if (s.length < 12) throw new Error('a senha precisa ter pelo menos 12 caracteres (uma frase de 4 ou 5 palavras é o ideal)');
    var t = s.toLowerCase().replace(/\s+/g, '');
    if (/^(.)\1+$/.test(t)) throw new Error('a senha não pode ser um caractere repetido');
    // Senha em letras latinas abaixo de 20 caracteres precisa de 3 palavras (de 3+ letras) distintas:
    // "Palmeirense!!", "Ronaldo123456789", "Senha Forte 2026" caem aqui; frases como "cavalo grampo bateria certa" passam.
    var palavras = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^\p{L}]+/u).filter(function (w) { return Array.from(w).length >= 3; });
    var latinas = palavras.length && palavras.every(function (w) { return /^[a-z]+$/.test(w); });
    var distintas = new Set(palavras).size;
    if (s.length < 20 && (palavras.length === 0 || (latinas && distintas < 3)))
      throw new Error('use uma frase de 3 ou mais palavras (ou 20 caracteres ou mais); uma ou duas palavras com números ou símbolos são fáceis de adivinhar');
    if (nucleoFraco(t)) throw new Error('essa senha é óbvia demais (números, sequências, repetição ou palavras comuns); use uma frase só sua');
    if (new Set(t).size < 5) throw new Error('a senha tem pouca variedade de caracteres');
  }

  var carregado = (async function () {
    // Arquivo local: todos os arquivos do computador compartilham o armazenamento. O site não abre dados aqui.
    if (location.protocol === 'file:') { cofre.bloqueio = 'arquivo-local'; return; }
    // Plano de troca pela metade: NUNCA é executado aqui quando há cofre; só depois da senha, com a prova conferida.
    var plano = null; try { plano = await Armazenamento.ler('cofreNovo'); } catch (e) {}
    if (plano != null && !planoValido(plano)) { cofre.avisos.push('um plano de troca de senha com formato inválido foi descartado (possível alteração externa)'); try { await limparPreparo(CHAVES_COFRE); } catch (e) {} plano = null; }
    var m1 = null, m2 = null;
    try { m1 = await Armazenamento.ler('cofre'); m2 = await Armazenamento.ler('cofreReserva'); } catch (e) {}
    var ok1 = metaValida(m1), ok2 = metaValida(m2);
    if (ok1 || ok2) {
      cofre.meta = ok1 ? m1 : m2; cofre.plano = plano;
      if (ok1 && ok2 && m1.sal !== m2.sal) { cofre.metaAlternativa = m2; if (!plano) cofre.avisos.push('as duas cópias da configuração da senha não conferem; possível alteração externa'); }
      else if (!(ok1 && ok2)) cofre.avisos.push('uma das cópias da configuração da senha sumiu ou foi alterada; usada a outra e refeita no desbloqueio');
      return;
    }
    if (plano && plano.meta) {
      // Criação de senha que ficou pela metade (ou plano plantado com senha de outra pessoa): só conclui com a senha do plano.
      cofre.meta = plano.meta; cofre.plano = plano; cofre.planoCriacao = true;
      return;
    }
    // Sem configuração: se ainda existe dado cifrado, alguém apagou a configuração. Recusa e trava.
    for (var i = 0; i < CHAVES_COFRE.length; i++) {
      var v = null; try { v = await Armazenamento.ler(CHAVES_COFRE[i]); } catch (e) {}
      if (ehCifrado(v)) {
        cofre.comprometido = 'A configuração da senha deste navegador sumiu, mas os dados continuam cifrados. Isso indica alteração feita por fora do site. Sem a configuração não é possível abrir os dados: apague os dados deste navegador e importe um backup.';
        return;
      }
    }
    if (plano) {
      // Sem senha no navegador: plano sem senha (remoção concluída pela metade ou importação) não tem o que proteger.
      try { await virar(plano); cofre.avisos.push('havia uma gravação pela metade (remoção de senha ou importação de backup), concluída agora; se você não fez nenhuma das duas, isso indica alteração externa'); }
      catch (e) { cofre.avisos.push('havia uma gravação pela metade que não pôde ser concluída (' + e.message + ')'); }
    }
    var apagado = null; try { apagado = await Armazenamento.ler('apagadoEm'); } catch (e) {}
    liberar();
    registrar('abertura', 'site aberto sem senha');
    cofre.avisos.forEach(function (a) { registrar('alerta', a); });
    if (apagado) {
      cofre.avisos.push('os dados deste navegador foram apagados pela tela de senha em ' + new Date(apagado).toLocaleString('pt-BR'));
      registrar('alerta', 'os dados deste navegador foram apagados pela tela de senha em ' + apagado);
      try { await Armazenamento.gravar('apagadoEm', null); } catch (e) {}
    }
  })();

  var Cofre = {
    disponivel: criptoDisponivel,
    validarSenha: function (s) { validarSenhaNova(s); return true; },
    estado: async function () {
      await carregado;
      var motivo = null; try { motivo = sessionStorage.getItem('cf1:motivoTrava'); sessionStorage.removeItem('cf1:motivoTrava'); } catch (e) {}
      return { ativo: !!cofre.meta, aberto: !!cofre.chave, criadoEm: cofre.meta && cofre.meta.criadoEm, comprometido: cofre.comprometido,
        bloqueio: cofre.bloqueio, avisos: cofre.avisos.slice(), motivoTrava: motivo, planoCriacao: cofre.planoCriacao };
    },
    desbloquear: async function (senha) {
      await carregado;
      if (cofre.comprometido) throw new Error('configuração da senha ausente');
      if (!cofre.meta) return { tentativasErradas: [] };
      var chave = null, metaUsada = null;
      var candidatas = [cofre.meta, cofre.metaAlternativa, cofre.plano && cofre.plano.meta].filter(function (m, i, a) { return m && a.indexOf(m) === i; });
      for (var c = 0; c < candidatas.length && !chave; c++) {
        try { chave = await conferirSenha(senha, candidatas[c]); metaUsada = candidatas[c]; } catch (e) {}
      }
      if (cofre.travando) throw new Error('o site está travando');
      if (!chave) { await registrar('senha-errada', ''); throw new Error('senha incorreta'); }

      // Plano pela metade: só executa com prova autenticada.
      if (cofre.plano) {
        var p = cofre.plano, autorizado = false;
        var metaGuardada = !cofre.planoCriacao && (metaUsada === cofre.meta || metaUsada === cofre.metaAlternativa);
        if (metaGuardada && await provaConfere(p.provaAntiga, chave, p)) autorizado = true;     // pedido por quem sabia a senha em vigor
        else if (p.meta && metaUsada.sal === p.meta.sal && await provaConfere(p.provaNova, chave, p)) {
          autorizado = true;                                                                      // quem digitou sabe a senha nova do plano
          if (cofre.planoCriacao) {
            // Criação pela metade: tudo o que está cifrado precisa abrir com esta senha; senão é dado de outra origem.
            for (var q = 0; q < CHAVES_COFRE.length && autorizado; q++) {
              var vs = [await Armazenamento.ler(CHAVES_COFRE[q]), await Armazenamento.ler('novo_' + CHAVES_COFRE[q])];
              for (var w = 0; w < vs.length; w++) if (ehCifrado(vs[w])) { try { await decifrarValor(CHAVES_COFRE[q], vs[w], chave); } catch (e) { autorizado = false; } }
            }
          }
        }
        if (!autorizado) {
          if (cofre.planoCriacao) {
            cofre.comprometido = 'Há uma criação de senha pela metade que não confere com os dados guardados. Isso indica alteração feita por fora do site: apague os dados deste navegador e importe um backup.';
            throw new Error('configuração inconsistente');
          }
          await comTrava('exclusive', function () { return limparPreparo(CHAVES_COFRE); });
          cofre.plano = null;
          cofre.avisos.push('um plano de troca de senha sem autorização foi encontrado e descartado (possível alteração externa)');
        } else if (await planoJaVirou(p)) {
          // A configuração guardada já é a do plano: os dados já foram trocados. Só completa as cópias e limpa (não regrava dados).
          await comTrava('exclusive', async function () {
            await Armazenamento.gravar('cofre', p.meta); await Armazenamento.gravar('cofreReserva', p.meta); await limparPreparo(CHAVES_COFRE);
          });
          cofre.plano = null; cofre.planoCriacao = false; cofre.meta = p.meta; cofre.metaAlternativa = null;
          if (metaUsada.sal !== p.meta.sal) { var er0 = new Error('troca-concluida'); er0.codigo = 'troca-concluida'; throw er0; }
          metaUsada = p.meta;
        } else if (await planoJaConcluido(p, chave)) {
          // Plano antigo replantado: já foi concluído antes (o registro cifrado guarda o identificador). Não reaplica.
          await comTrava('exclusive', function () { return limparPreparo(CHAVES_COFRE); });
          cofre.plano = null; cofre.planoCriacao = false;
          cofre.avisos.push('um plano de troca de senha já concluído antes foi encontrado de novo e descartado (possível alteração externa)');
          if (metaUsada !== cofre.meta && metaUsada !== cofre.metaAlternativa) { await registrar('senha-errada', ''); throw new Error('senha incorreta'); }
        } else {
          await comTrava('exclusive', function () { return virar(p); });
          registrar('plano-concluido', p.id || '');
          cofre.plano = null; cofre.planoCriacao = false;
          var NOMES_PLANO = { restaurar: 'importação de backup', remover: 'remoção da senha', criar: 'criação da senha', trocar: 'troca de senha' };
          var tipo = NOMES_PLANO[p.tipo] || 'troca de senha';
          cofre.avisos.push('a ' + tipo + ' que tinha ficado pela metade foi concluída agora');
          if (!p.meta) {
            // Remoção concluída: os dados agora estão sem cifra.
            cofre.meta = null; cofre.chave = null; cofre.metaAlternativa = null;
            cofre.avisos.forEach(function (a) { registrar('alerta', a); }); cofre.avisos = [];
            registrar('cofre-removido', 'remoção pela metade concluída no desbloqueio');
            liberar(); return { tentativasErradas: [] };
          }
          if (metaUsada.sal !== p.meta.sal) {
            // Troca concluída com a senha ANTIGA: daqui em diante vale a nova.
            cofre.meta = p.meta; cofre.metaAlternativa = null;
            var er = new Error('troca-concluida'); er.codigo = 'troca-concluida'; throw er;
          }
          metaUsada = p.meta;
        }
      }
      cofre.chave = chave; cofre.meta = metaUsada; cofre.metaAlternativa = null;

      // Refaz cópias da configuração só se faltar; nunca sobrescreve uma cópia válida de outra aba.
      try {
        await comTrava('exclusive', async function () {
          if (cofre.travando) throw new Error('travando');
          var g1 = await Armazenamento.ler('cofre'), g2 = await Armazenamento.ler('cofreReserva');
          var iguais = [g1, g2].filter(function (g) { return metaValida(g) && g.sal === cofre.meta.sal; }).length;
          var outras = [g1, g2].filter(function (g) { return metaValida(g) && g.sal !== cofre.meta.sal; }).length;
          if (outras && !iguais) { travarEstaAba('a senha do site mudou em outra aba'); throw new Error('a senha do site mudou em outra aba'); }
          if (iguais < 2) { await Armazenamento.gravar('cofre', cofre.meta); await Armazenamento.gravar('cofreReserva', cofre.meta); }
        });
      } catch (e) { if (cofre.travando) throw new Error('o site está travando'); }
      // Registro pendente: só senha errada, só o horário, e dentro de um período plausível.
      var pend = []; try { pend = (await Armazenamento.ler('registroPendente')) || []; } catch (e) {}
      if (!Array.isArray(pend)) pend = [];
      var reg = null; try { reg = await lerSeguro('registro'); } catch (e) {}
      var desde = reg && reg.itens && reg.itens.length ? Date.parse(reg.itens[reg.itens.length - 1].em) - 60000 : 0;
      var agora = Date.now(), aceitas = [], descartadas = 0;
      pend.forEach(function (p) {
        var t = p && typeof p.em === 'string' ? Date.parse(p.em) : NaN;
        if (p && p.tipo === 'senha-errada' && isFinite(t) && t <= agora + 300000 && t >= desde) aceitas.push(new Date(t).toISOString());
        else descartadas++;
      });
      try { await Armazenamento.gravar('registroPendente', null); } catch (e) {}
      aceitas.forEach(function (em) { registrar('senha-errada', 'tentativa com o site travado em ' + em + ' (anotada sem autenticação)'); });
      if (descartadas) registrar('alerta', descartadas + ' anotação(ões) inválida(s) no registro pendente foram descartadas (possível alteração externa)');
      cofre.avisos.forEach(function (a) { registrar('alerta', a); });
      filaTravada.splice(0).forEach(function (e) { registrar(e.tipo, (e.detalhe || '') + ' (com o site travado, às ' + e.em + ')'); });
      registrar('desbloqueio', '');
      liberar();
      return { tentativasErradas: aceitas, descartadas: descartadas, avisos: cofre.avisos.slice() };
    },
    criar: function (senha) {
      return exclusivo(async function () {
        await carregado;
        if (cofre.meta) throw new Error('o site já tem senha');
        if (cofre.comprometido || cofre.bloqueio) throw new Error('não é possível criar a senha neste estado');
        if (!criptoDisponivel()) throw new Error('este navegador não oferece criptografia nesta página');
        validarSenhaNova(senha);
        await filaReg;
        var n = await novaMeta(senha, { criadoEm: new Date().toISOString() });
        await comTrava('exclusive', async function () {
          if (metaValida(await Armazenamento.ler('cofre'))) throw new Error('outra aba criou a senha agora');
          var aberto = await lerTudoAberto();
          try { await migrar(await cifrarTudo(aberto, n.chave), n.meta, 'criar', null, n.chave); }
          catch (e) { if (e.codigo === ERRO_PENDENTE) { avisarAbas('cofre-mudou'); travarEstaAba('a criação da senha ficou pela metade; abra com a senha nova para concluir'); } throw e; }
          // Estado da aba atualizado ainda com a trava na mão: nenhuma gravação desta aba vê o disco já cifrado sem a chave.
          cofre.meta = n.meta; cofre.chave = n.chave;
        });
        avisarAbas('cofre-mudou');
        registrar('cofre-criado', 'dados cifrados com a senha do site');
        return true;
      });
    },
    trocarSenha: function (atual, nova) {
      return exclusivo(async function () {
        await carregado;
        if (!cofre.meta || !cofre.chave) throw new Error('o site está sem senha ou travado');
        try { await conferirSenha(atual, cofre.meta); } catch (e) { registrar('senha-errada', 'ao trocar a senha'); throw new Error('senha atual incorreta'); }
        validarSenhaNova(nova);
        await filaReg;
        var n = await novaMeta(nova, { criadoEm: cofre.meta.criadoEm, trocadaEm: new Date().toISOString() });
        await comTrava('exclusive', async function () {
          await conferirMetaGuardada();
          var aberto = await lerTudoAberto();
          try { await migrar(await cifrarTudo(aberto, n.chave), n.meta, 'trocar', cofre.chave, n.chave); }
          catch (e) { if (e.codigo === ERRO_PENDENTE) { avisarAbas('cofre-mudou'); travarEstaAba('a troca de senha ficou pela metade; ela será concluída ao abrir (vale a senha nova)'); } throw e; }
          cofre.meta = n.meta; cofre.chave = n.chave;
        });
        avisarAbas('cofre-mudou');
        registrar('senha-trocada', '');
        return true;
      });
    },
    remover: function (senha) {
      return exclusivo(async function () {
        await carregado;
        if (!cofre.meta || !cofre.chave) throw new Error('o site está sem senha ou travado');
        try { await conferirSenha(senha, cofre.meta); } catch (e) { registrar('senha-errada', 'ao remover a senha'); throw new Error('senha incorreta'); }
        await filaReg;
        await comTrava('exclusive', async function () {
          await conferirMetaGuardada();
          var aberto = await lerTudoAberto();
          try { await migrar(aberto, null, 'remover', cofre.chave, null); }
          catch (e) { if (e.codigo === ERRO_PENDENTE) { avisarAbas('cofre-mudou'); travarEstaAba('a remoção da senha ficou pela metade; abra com a senha atual para concluir'); } throw e; }
          cofre.chave = null; cofre.meta = null;
        });
        avisarAbas('cofre-mudou');
        registrar('cofre-removido', 'dados voltam a ficar sem cifra neste navegador');
        return true;
      });
    },
    /* Trava: anota, avisa as outras abas, esconde a tela, esquece a chave e recarrega (limpa a memória). */
    travar: async function (motivo) {
      if (!cofre.meta || cofre.travando) return;
      try { document.body.classList.add('travado'); } catch (e) {}
      await registrar('travado', motivo || 'pelo botão');
      avisarAbas('travar');
      travarEstaAba(motivo || 'pelo botão');
    },
    /* Esqueci a senha: apaga os dados deste navegador (não há como abrir sem a senha) e deixa um marcador. */
    apagarTudo: async function () {
      var ks = CHAVES_COFRE.concat(['cofre', 'cofreReserva', 'cofreNovo', 'registroPendente']).concat(CHAVES_COFRE.map(function (k) { return 'novo_' + k; }));
      for (var i = 0; i < ks.length; i++) { try { await Armazenamento.gravar(ks[i], null); } catch (e) {} }
      try { await Armazenamento.gravar('apagadoEm', new Date().toISOString()); } catch (e) {}
      avisarAbas('cofre-mudou');
      cofre.meta = null; cofre.chave = null;
      location.reload();
    }
  };

  var Registro = {
    ler: async function () {
      await pronto; await filaReg;
      var r = null; try { r = await lerSeguro('registro'); } catch (e) {}
      r = r || { n: 0, h: '', base: '', itens: [] };
      return { itens: r.itens.slice(), verificacao: await verificarRegistro(r), alertasSessao: alertasSessao.slice(), autenticado: !!cofre.meta };
    },
    exportar: async function () {
      var r = await Registro.ler();
      registrar('registro-exportado', '');
      return { app: 'controle-financeiro', tipo: 'registro-de-atividade', versaoSite: VERSAO_SITE, ambiente: AMBIENTE,
        exportadoEm: new Date().toISOString(), autenticado: r.autenticado, verificacao: r.verificacao, itens: r.itens };
    }
  };


  /* Importação de backup em duas fases (mesmo mecanismo da troca de senha). */
  async function restaurarDados(dados) {
    await pronto;
    if (cofre.travando) throw new Error('o site está travando');
    await filaReg;
    await comTrava('exclusive', async function () {
      if (cofre.chave) await conferirMetaGuardada();
      else if (metaValida(await Armazenamento.ler('cofre'))) { travarEstaAba('a senha do site foi criada em outra aba'); throw new Error('a senha do site foi criada em outra aba'); }
      var valores = {};
      for (var i = 0; i < CHAVES_USUARIO.length; i++) {
        var k = CHAVES_USUARIO[i], v = dados[k] == null ? null : dados[k];
        valores[k] = (cofre.chave && v != null) ? await cifrarValor(k, v) : v;
      }
      // O que não pôde ser lido (ou não coube na área separada) é preservado na área separada antes de ser substituído.
      var preservar = [];
      for (var j = 0; j < CHAVES_USUARIO.length; j++) {
        var kk = CHAVES_USUARIO[j];
        if (ilegivel[kk]) preservar.push({ motivo: 'conteúdo ilegível de "' + kk + '" preservado ao importar um backup', valor: await Armazenamento.ler(kk) });
        (invalidosPendentes[kk] || []).forEach(function (c) { preservar.push({ motivo: 'cenário inválido preservado ao importar um backup', valor: c }); });
      }
      if (preservar.length) {
        var q; try { q = await lerQuarentena(); } catch (e) { q = [{ em: new Date().toISOString(), motivo: 'área separada anterior ilegível; conteúdo bruto preservado', valor: await Armazenamento.ler('quarentena') }]; }
        for (var w = 0; w < preservar.length; w++) {
          var tx = JSON.stringify(preservar[w].valor);
          q.push({ em: new Date().toISOString(), motivo: preservar[w].motivo, h: (await hashHex(tx)) || tx, valor: preservar[w].valor });
        }
        valores.quarentena = cofre.chave ? await cifrarValor('quarentena', q) : q;
      }
      try { await migrar(valores, cofre.meta || null, 'restaurar', cofre.chave, cofre.chave); }
      catch (e) {
        // Pela metade: recarrega a página (com ou sem senha) para nada ser gravado antes de concluir o plano.
        if (e.codigo === ERRO_PENDENTE) {
          bloqueioGravacao = 'a importação ficou pela metade; a página vai recarregar para concluí-la antes de qualquer gravação';
          avisarAbas('cofre-mudou');
          setTimeout(function () { travarEstaAba('a importação ficou pela metade; ela será concluída ao abrir o site'); }, 2500);
        }
        throw e;
      }
    });
    CHAVES_USUARIO.forEach(function (k) { ilegivel[k] = false; });
  }

  /* Entrega um arquivo ao usuário: produção usa link de download; no artifact, a capability downloads. */
  async function salvarArquivo(nome, texto) {
    if (AMBIENTE === 'homologacao' && root.claude && root.claude.use) {
      var dl = await root.claude.use('downloads');
      if (!dl) throw new Error('download indisponível nesta visualização');
      return dl.save({ filename: nome, data: texto });
    }
    var url = URL.createObjectURL(new Blob([texto], { type: 'application/json' }));
    var a = document.createElement('a'); a.href = url; a.download = nome; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  /* Preferências de tela permitidas fora da Porta (sem dado financeiro). */
  var PREFS = ['cenarioAberto'];
  function pref(k) { if (PREFS.indexOf(k) < 0) throw new Error('preferência não permitida: ' + k); return k; }

  root.Dados = {
    VERSAO_SITE: VERSAO_SITE, AMBIENTE: AMBIENTE, REGRAS_VERIFICADAS: '2026-11-03',
    armazenamento: function () { return { nome: Armazenamento.nome + (cofre.meta ? ', cifrado com a senha do site' : '') }; },
    /* Dados do usuário: sempre pela Porta. */
    ler: function (k) { if (CHAVES_USUARIO.indexOf(k) < 0) return Promise.reject(new Error('chave não permitida')); return Porta.ler(k); },
    gravar: function (k, v) { if (CHAVES_USUARIO.indexOf(k) < 0) return Promise.reject(new Error('chave não permitida')); return Porta.gravar(k, v); },
    /* Preferências de tela (último cenário aberto): só neste navegador, fora do backup e do cofre. */
    lerLocal: function (k) { return Local.ler(pref(k)); },
    gravarLocal: function (k, v) { return Local.gravar(pref(k), v); },
    cofre: Object.freeze(Cofre), registro: Object.freeze(Registro),
    quarentena: Object.freeze({
      resumo: async function () {
        await pronto;
        var q; try { q = await lerQuarentena(); } catch (e) { return [{ em: new Date().toISOString(), motivo: 'a área separada está ilegível (alterada fora do site?); você pode baixar o conteúdo bruto ou apagá-la' }]; }
        return q.map(function (x) { return { em: x.em, motivo: x.motivo }; });
      },
      /* Cópia para guardar: cifrada com a senha do site quando ela existe. */
      exportar: async function () {
        await pronto;
        var q; try { q = await lerQuarentena(); } catch (e) { q = [{ motivo: 'área separada ilegível; conteúdo bruto', valor: await Armazenamento.ler('quarentena') }]; }
        var b = { app: 'controle-financeiro', esquema: VERSAO_ESQUEMA, versaoSite: VERSAO_SITE, ambiente: AMBIENTE, exportadoEm: new Date().toISOString(), dados: { areaSeparada: q } };
        registrar('alerta', 'cópia da área separada exportada (' + q.length + ' item(ns))');
        return cofre.chave ? Backup.cifrarComCofre(b) : b;
      },
      apagar: async function () {
        await pronto;
        var n = '?'; try { n = (await lerQuarentena()).length; } catch (e) {}
        await gravarSeguro('quarentena', null);
        registrar('alerta', 'área separada apagada pelo usuário (' + n + ' item(ns))');
        return n;
      }
    }),
    semTravaEntreAbas: function () { return !(root.navigator && root.navigator.locks) || typeof root.BroadcastChannel !== 'function'; },
    descartarIlegivel: function (k) { if (CHAVES_USUARIO.indexOf(k) < 0) return Promise.reject(new Error('chave não permitida')); return Porta.descartarIlegivel(k); },
    mercado: Mercado, premissasDe: premissasDe, hoje: hojeLocal,
    feriados: function () { return lerJson('data/feriados.json'); },
    referencia: function () { return lerJson('data/referencia.json'); },
    exemplos: function () { return lerJson('data/exemplos.json'); },
    carteiraExemplo: function () { return lerJson('data/carteira-exemplo.json'); },
    validarLancamento: function (l) { return validarLancamento(l); },
    validarItemProvento: function (i) { return validarItemProvento(i); },
    backup: Object.freeze(Backup), salvarArquivo: salvarArquivo, diasUteisDesde: diasUteisDesde
  };
  Object.freeze(root.Dados);
})(window);
