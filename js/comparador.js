/*
 * Controle Financeiro — Comparador de renda fixa (F1; layout em caixas na F1.2).
 * Lê window.Dados, calcula com window.MotorRF e mostra. Nenhuma fórmula financeira aqui:
 * a interface só converte unidades (% → decimal), monta os fluxos e formata.
 */
(function () {
  'use strict';
  var D = window.Dados, M = window.MotorRF;
  var $ = function (s) { return document.querySelector(s); };
  var raiz = $('#comparador');
  if (!raiz || !M) return;

  /* ================= formatação pt-BR ================= */
  var BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  function nf(v, dec) { return v.toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec }); }
  function reais(v) { return v == null || isNaN(v) ? '—' : BRL.format(v); }
  function reaisSinal(v) { return v == null ? '—' : (v < 0 ? '− ' + BRL.format(-v) : BRL.format(v)); }
  function pct(v, dec) { return v == null || isNaN(v) ? '—' : nf(v * 100, dec == null ? 2 : dec) + '%'; }
  function pctPP(v) { return (v >= 0 ? '+' : '−') + nf(Math.abs(v * 100), 2) + ' p.p.'; }
  function dataBR(iso) { if (!iso) return '—'; var p = String(iso).slice(0, 10).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  var DIAS_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  function el(tag, attrs, texto) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (attrs[k] === false || attrs[k] == null) return;
      if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    if (texto != null) e.textContent = texto;
    return e;
  }
  function add(pai) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) pai.appendChild(typeof arguments[i] === 'string' ? document.createTextNode(arguments[i]) : arguments[i]); return pai; }

  /* Entrada: aceita vírgula ou ponto. Dinheiro: "1.234,56", "1234,56", "1234.56", "50.000". */
  function lerNumero(txt, dinheiro) {
    if (txt == null) return null;
    var s = String(txt).trim().replace(/\s|R\$|%/g, '');
    if (!s) return null;
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    else if (dinheiro && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
    var n = Number(s);
    return isFinite(n) ? n : NaN;
  }

  /* ================= catálogo de produtos ================= */
  var TIPOS = [
    { id: 'CDB', nome: 'CDB', ix: ['CDI', 'PRE', 'IPCA'] },
    { id: 'RDB', nome: 'RDB', ix: ['CDI', 'PRE', 'IPCA'] },
    { id: 'LC', nome: 'LC', ix: ['CDI', 'PRE', 'IPCA'] },
    { id: 'LCI', nome: 'LCI', ix: ['CDI', 'PRE', 'IPCA'] },
    { id: 'LCA', nome: 'LCA', ix: ['CDI', 'PRE', 'IPCA'] },
    { id: 'LCD', nome: 'LCD', ix: ['CDI', 'PRE', 'IPCA'] },
    { id: 'CRI', nome: 'CRI', ix: ['CDI', 'CDI_MAIS', 'PRE', 'IPCA'] },
    { id: 'CRA', nome: 'CRA', ix: ['CDI', 'CDI_MAIS', 'PRE', 'IPCA'] },
    { id: 'DEB', nome: 'Debênture comum', ix: ['CDI', 'CDI_MAIS', 'PRE', 'IPCA'] },
    { id: 'DEB_INCENTIVADA', nome: 'Debênture incentivada', ix: ['CDI', 'CDI_MAIS', 'PRE', 'IPCA'] },
    { id: 'TESOURO', nome: 'Tesouro Direto', ix: ['SELIC', 'PRE', 'IPCA'] },
    { id: 'POUPANCA', nome: 'Poupança', ix: [] },
    { id: 'FUNDO_RF_LP', nome: 'Fundo RF/DI longo prazo', ix: ['CDI'] },
    { id: 'FUNDO_RF_CP', nome: 'Fundo RF/DI curto prazo', ix: ['CDI'] }
  ];
  var IX = {
    CDI: { nome: '% do CDI', campo: 'pctCDI', rotulo: '% do CDI', ph: 'ex.: 102', sufixo: '% do CDI' },
    CDI_MAIS: { nome: 'CDI + taxa', campo: 'spreadAA', rotulo: 'CDI + (% a.a.)', ph: 'ex.: 1,50', prefixo: 'CDI + ', sufixo: '% a.a.' },
    PRE: { nome: 'Prefixado', campo: 'taxaAA', rotulo: 'Taxa (% a.a.)', ph: 'ex.: 13,20', sufixo: '% a.a.' },
    IPCA: { nome: 'IPCA +', campo: 'jurosRealAA', rotulo: 'IPCA + (% a.a.)', ph: 'ex.: 7,20', prefixo: 'IPCA + ', sufixo: '% a.a.' },
    SELIC: { nome: 'Selic +', campo: 'spreadAA', rotulo: 'Selic + (% a.a.)', ph: 'ex.: 0,05', prefixo: 'Selic + ', sufixo: '% a.a.' }
  };
  var LIQUIDEZ = [
    { id: 'diaria', nome: 'Diária' },
    { id: 'carencia', nome: 'Com carência' },
    { id: 'vencimento', nome: 'Só no vencimento' }
  ];
  function tipoDe(id) { return TIPOS.filter(function (t) { return t.id === id; })[0]; }
  function isento(tipo) { return M.ISENTOS_IR.indexOf(tipo) >= 0; }
  function ehFundo(tipo) { return /^FUNDO_RF/.test(tipo); }
  function rotuloProduto(p, i) { return (p && p.nome) ? p.nome : 'Produto ' + (i + 1); }

  /* ================= estado ================= */
  var E = {
    salvos: [],          // cenários gravados (Dados 'cenarios')
    rascunhos: {},       // id → cópia editada ainda não salva
    exemplos: null,      // array quando o modo exemplo está ligado (só na memória)
    referencia: null,    // conteúdo de data/referencia.json
    feriados: null,      // {lista, cobertura, fonte} ou null se não carregou
    mercado: null,       // último retrato de mercado
    atualId: null,
    desfazer: null,      // {texto, fn}
    comparando: false, selecao: [],
    detAberto: false     // "Detalhes" das caixas de produto (abre/fecha todas juntas)
  };
  var uid = function () { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); };
  function copia(o) { return JSON.parse(JSON.stringify(o)); }

  function todos() {
    var l = E.salvos.map(function (c) { return E.rascunhos[c.id] || c; });
    Object.keys(E.rascunhos).forEach(function (id) { if (E.rascunhos[id]._novo) l.push(E.rascunhos[id]); });
    return l;
  }
  function achar(id) {
    if (E.rascunhos[id]) return E.rascunhos[id];
    var s = E.salvos.filter(function (c) { return c.id === id; })[0]; if (s) return s;
    if (E.exemplos) { var x = E.exemplos.filter(function (c) { return c.id === id; })[0]; if (x) return x; }
    var rf = refDe(id); if (rf) return rf.cenario;
    return null;
  }
  /* F2: data/referencia.json pode ter vários cenários (produtos reais com prazos diferentes). */
  function refs() { return (E.referencia && E.referencia.cenarios) || []; }
  function refDe(id) { return refs().filter(function (r) { return r.cenario.id === id; })[0] || null; }
  function atual() { return achar(E.atualId); }
  /* Grupo pela origem real (lista de referência do site ou exemplos em memória), nunca por marca vinda do dado. */
  function grupo(c) {
    if (!c) return null;
    var rf = refDe(c.id); if (rf && rf.cenario === c) return 'referencia';
    if (E.exemplos && E.exemplos.indexOf(c) >= 0) return 'exemplo';
    return 'meu';
  }
  function sujo(c) { return c && grupo(c) === 'meu' && !!E.rascunhos[c.id]; }

  /* Edição: cenários do usuário viram rascunho; exemplos são editados só na memória; referência é fixa. */
  function editavel() {
    var c = atual(); if (!c) return null;
    var g = grupo(c);
    if (g === 'referencia') return null;
    if (g === 'exemplo') return c;
    if (!E.rascunhos[c.id]) E.rascunhos[c.id] = copia(c);
    return E.rascunhos[c.id];
  }

  function cenarioNovo() {
    return { id: uid(), nome: 'Novo cenário', valor: null, aporteMensal: null, dataInicio: proximoDiaUtil(D.hoje()),
      prazoDias: null, premissas: {}, duEditado: null, aliqIREditada: null,
      produtos: [produtoVazio(), produtoVazio()], criadoEm: new Date().toISOString() };
  }
  function produtoVazio() { return { nome: '', tipo: '', indexador: '', emissor: '', liquidez: '' }; }

  /* ================= datas ================= */
  function isoMais(iso, dias) { var d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10); }
  function isoMaisMeses(iso, meses) {
    var p = iso.split('-').map(Number), y = p[0], m = p[1] - 1 + meses, dd = p[2];
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    var ult = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(Math.min(dd, ult)).padStart(2, '0');
  }
  function diaSemana(iso) { return new Date(iso + 'T12:00:00Z').getUTCDay(); }
  function ehUtil(iso) { var w = diaSemana(iso); return w !== 0 && w !== 6 && !(E.feriados && E.feriados.lista.indexOf(iso) >= 0); }
  function proximoDiaUtil(iso) { var d = iso; for (var i = 0; i < 10 && !ehUtil(d); i++) d = isoMais(d, 1); return d; }

  /* ================= premissas ================= */
  var PREMISSAS = ['cdiAA', 'selicAA', 'selicMetaAA', 'trAM', 'ipcaProjAA'];
  function premissas(c) {
    var fixo = !!c.mercadoFixo;
    var base = D.premissasDe(fixo ? c.mercadoFixo : E.mercado);
    PREMISSAS.forEach(function (k) {
      base[k].origem = fixo ? 'fixo' : (base[k].projecao ? 'projecao' : 'mercado');
      var ov = c.premissas && c.premissas[k];
      if (ov != null) { base[k].valorMercado = base[k].valor; base[k].valor = ov; base[k].origem = 'editado'; }
    });
    return base;
  }
  function mercadoMotor(pr) { var m = {}; PREMISSAS.forEach(function (k) { if (pr[k].valor != null) m[k] = pr[k].valor; }); return m; }

  /* ================= cálculo ================= */
  var NOMES_AVISO = {
    'produto.pctCDI': 'falta o % do CDI', 'produto.taxaAA': 'falta a taxa prefixada', 'produto.jurosRealAA': 'falta a taxa acima do IPCA',
    'produto.spreadAA': 'falta a taxa adicional (spread)', 'produto.taxaAdmAA': 'falta a taxa de administração do fundo',
    'mercado.cdiAA': 'falta o CDI (premissa)', 'mercado.selicAA': 'falta a Selic over (premissa)', 'mercado.selicMetaAA': 'falta a Selic meta (premissa)',
    'mercado.trAM': 'falta a TR (premissa)'
  };
  function traduz(a) {
    if (NOMES_AVISO[a]) return NOMES_AVISO[a];
    if (/^produto\.custodiaAA/.test(a)) return 'falta a taxa de custódia (0 se isento)';
    if (/^produto\.spreadAA/.test(a)) return 'falta a taxa acima da Selic (0 se não houver)';
    if (/^mercado\.ipcaProjAA/.test(a)) return 'falta o IPCA projetado (premissa)';
    if (/indexador desconhecido/.test(a)) return 'falta o indexador';
    return a;
  }

  function produtoMotor(p) {
    var out = { tipo: p.tipo };
    if (p.tipo !== 'POUPANCA') out.indexador = p.indexador;
    ['pctCDI', 'taxaAA', 'jurosRealAA', 'spreadAA', 'custodiaAA', 'taxaAdmAA'].forEach(function (k) {
      if (p[k] != null && p[k] !== '' && !isNaN(p[k])) out[k] = p[k] / 100;
    });
    return out;
  }

  function calcular(c) {
    var R = { avisos: [], produtos: [], pr: premissas(c) };
    var faltas = [];
    if (c.valor == null || isNaN(c.valor) || c.valor <= 0) faltas.push('valor inicial');
    if (!c.dataInicio) faltas.push('data de aplicação');
    if (c.prazoDias == null || isNaN(c.prazoDias) || c.prazoDias < 1) faltas.push('prazo em dias');
    R.faltasCenario = faltas;
    if (c.aporteMensal != null && (isNaN(c.aporteMensal) || c.aporteMensal < 0)) faltas.push('aporte mensal válido');
    if (!faltas.length) {
      R.dataResgate = isoMais(c.dataInicio, Math.round(c.prazoDias));
      R.dc = M.diasCorridos(c.dataInicio, R.dataResgate);
      R.duCalendario = M.diasUteis(c.dataInicio, R.dataResgate, E.feriados ? E.feriados.lista : []);
      R.du = c.duEditado != null ? c.duEditado : R.duCalendario;
      R.aliqRegra = M.aliquotaIR(R.dc);
      R.aliqIR = c.aliqIREditada != null ? c.aliqIREditada : R.aliqRegra;
      R.aliqIOF = M.aliquotaIOF(R.dc);
      R.fluxos = [{ data: c.dataInicio, valor: c.valor }];
      if (c.aporteMensal > 0) {
        for (var k = 1; k < 1200; k++) {
          var d = isoMaisMeses(c.dataInicio, k);
          if (d >= R.dataResgate) break;
          R.fluxos.push({ data: d, valor: c.aporteMensal });
        }
      }
      if (!E.feriados) R.avisos.push('Calendário ANBIMA não carregou: dias úteis estimados de segunda a sexta, sem feriados.');
      else if (R.dataResgate > E.feriados.cobertura.ate) R.avisos.push('O calendário de feriados cobre até ' + dataBR(E.feriados.cobertura.ate) + '; depois disso os dias úteis não descontam feriados.');
      if (!ehUtil(R.dataResgate)) R.avisos.push('O resgate cai em ' + dataBR(R.dataResgate) + ' (' + (E.feriados && E.feriados.lista.indexOf(R.dataResgate) >= 0 ? 'feriado' : DIAS_SEMANA[diaSemana(R.dataResgate)]) + '). Títulos com vencimento em dia não útil costumam pagar no dia útil seguinte; o cálculo usa a data exata.');
      if (!ehUtil(c.dataInicio)) R.avisos.push('A data de aplicação (' + dataBR(c.dataInicio) + ') não é dia útil.');
    }
    var mm = mercadoMotor(R.pr);
    (c.produtos || []).forEach(function (p, i) {
      var x = { p: p, i: i, nome: rotuloProduto(p, i), faltas: [] };
      if (!p.tipo) x.faltas.push('falta o tipo do produto');
      else if (p.tipo !== 'POUPANCA' && !p.indexador) x.faltas.push('falta o indexador');
      if (p.tipo && p.indexador && IX[p.indexador]) {
        var v = p[IX[p.indexador].campo];
        if (v != null && isNaN(v)) x.faltas.push('taxa digitada não é um número');
      }
      if (!faltas.length && !x.faltas.length) {
        var r = M.simular(R.fluxos, R.dataResgate, produtoMotor(p), mm, E.feriados ? E.feriados.lista : [],
          { du: c.duEditado, aliqIR: c.aliqIREditada });
        r.avisos.forEach(function (a) { var t = traduz(a); if (x.faltas.indexOf(t) < 0) x.faltas.push(t); });
        if (r.final != null) { x.r = r; indicadores(x, R, mm); }
      }
      x.ok = !!x.r;
      x.riscos = riscos(p, x);
      R.produtos.push(x);
    });
    veredito(R);
    return R;
  }

  function indicadores(x, R, mm) {
    var r = x.r, unico = R.fluxos.length === 1, p = x.p;
    x.capital = r.capital;
    x.aportesMensais = r.capital - R.fluxos[0].valor;
    x.rentPeriodo = r.rendLiquido / r.capital;
    x.aa252 = unico ? M.anualizar(x.rentPeriodo, r.partes[0].du, 252) : null;
    x.tir = r.tirAA;
    var aliqs = r.partes.map(function (q) { return q.aliqIR; }), iofs = r.partes.map(function (q) { return q.aliqIOF; });
    x.aliqIRMin = Math.min.apply(null, aliqs); x.aliqIRMax = Math.max.apply(null, aliqs);
    x.aliqIOFMax = Math.max.apply(null, iofs);
    if (unico && mm.cdiAA != null) x.pctCDIEq = M.pctCDIEquivalente(r.rendLiquido, r.capital, mm.cdiAA, r.partes[0].du, R.dc);
    if (isento(p.tipo) && p.tipo !== 'POUPANCA') {
      var aliq = R.aliqIR;
      if (p.indexador === 'CDI') x.grossUp = { texto: 'equivale a ' + nf(M.grossUp(p.pctCDI, R.dc, aliq), 1) + '% do CDI tributado' };
      else if (p.indexador === 'PRE') x.grossUp = { texto: 'equivale a ' + nf(M.grossUp(p.taxaAA, R.dc, aliq), 2) + '% a.a. pré tributado' };
      else if (p.indexador === 'IPCA') x.grossUp = { texto: 'equivale a IPCA + ' + nf(M.grossUp(p.jurosRealAA, R.dc, aliq), 2) + '% a.a. tributado (aprox., só sobre o juro real)' };
      else if (p.indexador === 'CDI_MAIS') x.grossUp = { texto: 'use o "equivalente em % do CDI" acima' };
    }
    if (mm.ipcaProjAA != null) {
      var infl = Math.pow(1 + mm.ipcaProjAA, R.dc / 365) - 1;
      x.realPeriodo = unico ? M.retornoReal(x.rentPeriodo, infl) : null;
      x.realAA = x.tir != null ? M.retornoReal(x.tir, mm.ipcaProjAA) : null;
    }
    if (mm.cdiAA != null) {
      x.taxaVPL = mm.cdiAA * (1 - R.aliqRegra);
      var cf = R.fluxos.map(function (f) { return { data: f.data, valor: -f.valor }; });
      cf.push({ data: R.dataResgate, valor: r.final });
      x.vpl = M.vpl(x.taxaVPL, cf);
    }
  }

  function riscos(p, x) {
    var t = p.tipo, ix = p.indexador, o = {};
    var fgcSim = ['CDB', 'RDB', 'LC', 'LCI', 'LCA', 'POUPANCA'].indexOf(t) >= 0;
    if (!t) o.fgc = { t: '—', nivel: 0 };
    else if (fgcSim) {
      o.fgc = { t: 'Sim, até R$ 250 mil por CPF e conglomerado (inclui juros)', nivel: 2 };
      if (x.r && x.r.final > 250000) o.fgc = { t: 'Sim, mas o patrimônio final (' + reais(x.r.final) + ') passa do limite de R$ 250 mil por conglomerado', nivel: 1, alerta: true };
    } else if (t === 'LCD') o.fgc = { t: 'Verificar no informe do emissor', nivel: 1, alerta: true };
    else if (t === 'TESOURO') o.fgc = { t: 'Não se aplica: risco soberano (Tesouro Nacional)', nivel: 3 };
    else o.fgc = { t: 'Não', nivel: 0 };

    if (t === 'TESOURO') o.emissor = { t: 'Tesouro Nacional' };
    else if (t === 'POUPANCA') o.emissor = p.emissor ? { t: p.emissor } : { t: '⚠ falta o banco', alerta: true };
    else o.emissor = p.emissor ? { t: p.emissor } : { t: '⚠ falta o emissor', alerta: true };

    if (t === 'TESOURO') o.liq = { t: 'Diária (recompra pelo Tesouro, a preço de mercado)', nivel: 3 };
    else if (t === 'POUPANCA') o.liq = { t: 'Diária (rende só no aniversário)', nivel: 3 };
    else if (p.liquidez === 'diaria') o.liq = { t: 'Diária', nivel: 3 };
    else if (p.liquidez === 'carencia') o.liq = p.carenciaDias ? { t: 'Carência de ' + p.carenciaDias + ' dias', nivel: 2 } : { t: '⚠ falta o prazo de carência', nivel: 2, alerta: true };
    else if (p.liquidez === 'vencimento') o.liq = { t: 'Só no vencimento', nivel: 1 };
    else o.liq = { t: '⚠ falta a liquidez', nivel: null, alerta: true };
    if ((t === 'LCI' || t === 'LCA') && o.liq.nivel === 3) o.liq.t += ' · confira a carência mínima regulatória (CMN) no produto';

    if (t === 'TESOURO') o.mam = ix === 'SELIC' ? { t: 'Baixa: o preço do Tesouro Selic oscila pouco', nivel: 2 } : { t: 'Sim: vendido antes do vencimento, sai a preço de mercado e pode dar prejuízo', nivel: 0 };
    else if (['CRI', 'CRA', 'DEB', 'DEB_INCENTIVADA'].indexOf(t) >= 0) o.mam = { t: 'Sim: venda antes do vencimento só no mercado secundário, a preço de mercado', nivel: 0 };
    else if (ehFundo(t)) o.mam = { t: 'Sim: a cota é marcada a mercado todo dia', nivel: 1 };
    else if (t === 'POUPANCA') o.mam = { t: 'Não', nivel: 3 };
    else if (!t) o.mam = { t: '—' };
    else if (p.liquidez === 'diaria') o.mam = { t: 'Não: resgate pela taxa contratada', nivel: 3 };
    else o.mam = { t: 'Venda antecipada só no secundário, com deságio possível', nivel: 1 };
    return o;
  }

  function veredito(R) {
    var ok = R.produtos.filter(function (x) { return x.ok; }).sort(function (a, b) { return b.r.final - a.r.final; });
    R.ranking = ok;
    if (ok.length < 2) return;
    var v = ok[0], s = ok[1];
    R.vencedor = v; R.segundo = s;
    R.dif = v.r.final - s.r.final;
    R.difAA = (v.tir != null && s.tir != null) ? v.tir - s.tir : null;
    var trocas = [];
    var nv = v.riscos, ns = s.riscos;
    if (nv.liq.nivel != null && ns.liq.nivel != null && nv.liq.nivel < ns.liq.nivel)
      trocas.push('liquidez pior (' + nv.liq.t.toLowerCase().split(' · ')[0] + ' contra ' + ns.liq.t.toLowerCase().split(' · ')[0] + ')');
    if (nv.fgc.nivel < ns.fgc.nivel && nv.fgc.nivel === 0) trocas.push('sem FGC (o ' + s.nome + ' tem)');
    if (nv.mam.nivel != null && ns.mam.nivel != null && nv.mam.nivel === 0 && ns.mam.nivel > 0) trocas.push('marcação a mercado se vender antes do vencimento');
    if (nv.fgc.alerta) trocas.push('passa do limite do FGC');
    R.trocas = trocas;
    R.faltaRisco = [v, s].some(function (x) { return ['emissor', 'liq'].some(function (k) { return /falta/.test(x.riscos[k].t); }); });
    // Pós × pré/IPCA: CDI médio que empata os dois.
    var pos = function (x) { return ['CDI', 'CDI_MAIS', 'SELIC'].indexOf(x.p.indexador) >= 0 || ehFundo(x.p.tipo); };
    var bestPos = ok.filter(pos)[0], bestOutro = ok.filter(function (x) { return !pos(x) && x.p.tipo !== 'POUPANCA'; })[0];
    if (bestPos && bestOutro && (bestPos === v || bestOutro === v)) {
      var c = atual(), mm = mercadoMotor(R.pr);
      var eq = M.cdiEquilibrio(bestOutro.r.final, R.fluxos, R.dataResgate, produtoMotor(bestPos.p), mm, E.feriados ? E.feriados.lista : [],
        { du: c.duEditado, aliqIR: c.aliqIREditada });
      if (eq != null) R.equilibrio = { pos: bestPos, outro: bestOutro, cdi: eq, ipca: bestOutro.p.indexador === 'IPCA' };
    }
  }

  /* ================= persistência ================= */
  async function salvarLista() {
    var limpos = E.salvos.map(function (c) { var x = copia(c); delete x._novo; return x; });
    await D.gravar('cenarios', limpos);
  }
  async function salvarAtual() {
    var c = atual(); if (!c || grupo(c) !== 'meu' || !E.rascunhos[c.id]) return;
    var r = copia(E.rascunhos[c.id]); delete r._novo; r.atualizadoEm = new Date().toISOString();
    var i = E.salvos.findIndex(function (x) { return x.id === r.id; });
    if (i >= 0) E.salvos[i] = r; else E.salvos.push(r);
    delete E.rascunhos[c.id];
    try { await salvarLista(); status('Cenário salvo às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '.'); }
    catch (e) { status('Não consegui salvar (' + (e.message || e) + '). Suas alterações continuam na tela.'); E.rascunhos[c.id] = r; }
    render();
  }
  function descartar() {
    var c = atual(); if (!c) return;
    var novo = E.rascunhos[c.id] && E.rascunhos[c.id]._novo;
    delete E.rascunhos[c.id];
    if (novo) E.atualId = (E.salvos[0] || (E.exemplos || [])[0] || {}).id || null;
    status('Alterações descartadas.');
    render();
  }

  /* ================= ações da barra ================= */
  function selecionar(id) { E.atualId = id; E.acao = null; D.gravarLocal('cenarioAberto', id); render(); }
  function novo() { var c = cenarioNovo(); c._novo = true; E.rascunhos[c.id] = c; selecionar(c.id); status('Cenário novo criado. Preencha valor, prazo e produtos e clique em Salvar.'); }
  async function duplicar() {
    var c = atual(); if (!c) return;
    if (c.exemplo || (c.referencia && E.referencia.provisorio)) return;
    var n = copia(c); n.id = uid(); n.nome = 'Cópia de ' + c.nome; delete n.exemplo; delete n.referencia; delete n.mercadoFixo; delete n._novo;
    n.criadoEm = new Date().toISOString();
    E.salvos.push(n); await salvarLista(); selecionar(n.id); status('Cenário duplicado e salvo. Ele usa os dados de mercado atuais.');
  }
  function pedirRenomear() { E.acao = 'renomear'; renderAcao(); var i = $('#cmp-novo-nome'); if (i) { i.focus(); i.select(); } }
  async function renomear(nome) {
    nome = (nome || '').trim(); if (!nome) { status('Digite um nome para o cenário.'); return; }
    var c = atual(); if (!c) return;
    c.nome = nome;
    var s = E.salvos.filter(function (x) { return x.id === c.id; })[0];
    if (s && s !== c) s.nome = nome;
    if (grupo(c) === 'meu' && s) await salvarLista();
    E.acao = null; status('Cenário renomeado.'); render();
  }
  function pedirExcluir() { E.acao = 'excluir'; renderAcao(); var b = $('#cmp-confirma-excluir'); if (b) b.focus(); }
  async function excluir() {
    var c = atual(); if (!c || grupo(c) !== 'meu') return;
    var i = E.salvos.findIndex(function (x) { return x.id === c.id; });
    var removido = i >= 0 ? E.salvos.splice(i, 1)[0] : null;
    var rasc = E.rascunhos[c.id]; delete E.rascunhos[c.id];
    if (removido) await salvarLista();
    E.acao = null;
    E.desfazer = { texto: 'Cenário "' + c.nome + '" excluído.', fn: async function () {
      if (removido) { E.salvos.splice(Math.min(i, E.salvos.length), 0, removido); await salvarLista(); }
      if (rasc) E.rascunhos[c.id] = rasc;
      E.desfazer = null; selecionar(c.id); status('Exclusão desfeita.');
    } };
    E.atualId = (todos()[0] || (E.exemplos || [])[0] || {}).id || null;
    render();
  }
  async function carregarExemplo() {
    try {
      var ex = await D.exemplos();
      E.exemplos = ex.cenarios.map(function (c) { c.exemplo = true; return c; });
      selecionar(E.exemplos[0].id);
      status('Exemplos carregados: dados fictícios, não são salvos e saem com "Sair do exemplo".');
    } catch (e) { status('Não consegui carregar os exemplos (' + e.message + ').'); }
  }
  function sairExemplo() {
    E.exemplos = null; E.comparando = false; E.selecao = [];
    var c = atual();
    if (!c || c.exemplo) E.atualId = (todos()[0] || {}).id || null;
    status('Exemplos removidos. Seus cenários não foram alterados.');
    render();
  }
  function abrirReferencia() { if (refs().length) selecionar(refs()[0].cenario.id); }

  var tStatus;
  function status(t) { var s = $('#cmp-status'); if (!s) return; s.textContent = t || ''; clearTimeout(tStatus); if (t) tStatus = setTimeout(function () { s.textContent = ''; }, 9000); }

  /* ================= renderização ================= */
  function render() {
    renderBarra(); renderAcao(); renderBanner();
    var c = atual();
    var corpo = $('#cmp-corpo');
    corpo.hidden = !c || E.comparando;
    $('#cmp-vazio').hidden = !!c || E.comparando;
    $('#cmp-comparacao').hidden = !E.comparando;
    if (E.comparando) { renderComparacao(); return; }
    if (!c) return;
    try {
      var R = calcular(c);
      renderParametros(c, R);
      renderVeredito(c, R);
      renderTabela(c, R);
      renderConferencia(c, R);
      renderPremissas(c, R);
      renderMemoria(c, R);
    } catch (e) {
      // Um cenário com problema não derruba a tela: mostra o aviso e deixa excluir.
      ['#cmp-veredito', '#cmp-tabela', '#cmp-add-wrap', '#cmp-premissas', '#cmp-memoria'].forEach(function (s) { var x = $(s); if (x) x.textContent = ''; });
      $('#cmp-conferencia').hidden = true;
      var box = $('#cmp-param'); box.textContent = '';
      add(box, el('h2', null, c.nome || 'Cenário'), el('p', { class: 'aviso' }, 'Este cenário tem um problema e não pôde ser calculado (' + (e.message || e) + '). Você pode excluí-lo.'));
      if (grupo(c) === 'meu') { var bx = el('button', { class: 'btn perigo', type: 'button' }, 'Excluir este cenário'); bx.addEventListener('click', pedirExcluir); box.appendChild(bx); }
    }
  }

  function renderBarra() {
    var sel = $('#cmp-sel'); sel.textContent = '';
    var meus = todos();
    var g1 = el('optgroup', { label: 'Meus cenários' });
    meus.forEach(function (c) { g1.appendChild(el('option', { value: c.id }, c.nome + (sujo(c) ? ' • não salvo' : ''))); });
    if (!meus.length) g1.appendChild(el('option', { disabled: true, value: '' }, '(nenhum ainda)'));
    sel.appendChild(g1);
    if (E.exemplos) {
      var g2 = el('optgroup', { label: 'Exemplo — dados fictícios' });
      E.exemplos.forEach(function (c) { g2.appendChild(el('option', { value: c.id }, c.nome)); });
      sel.appendChild(g2);
    }
    if (refs().length) {
      var g3 = el('optgroup', { label: 'Teste' });
      refs().forEach(function (r) { g3.appendChild(el('option', { value: r.cenario.id }, r.cenario.nome)); });
      sel.appendChild(g3);
    }
    if (E.atualId) sel.value = E.atualId;
    var c = atual(), g = grupo(c);
    $('#cmp-duplicar').disabled = !c || g === 'exemplo' || (g === 'referencia' && E.referencia.provisorio);
    $('#cmp-duplicar').title = g === 'exemplo' ? 'Exemplos são fictícios e não viram cenário seu' : '';
    $('#cmp-renomear').disabled = !c || g === 'referencia';
    $('#cmp-excluir').disabled = !c || g !== 'meu' || (E.rascunhos[c.id] && E.rascunhos[c.id]._novo);
    $('#cmp-exemplo').textContent = E.exemplos ? 'Sair do exemplo' : 'Carregar exemplo';
    $('#cmp-comparar').setAttribute('aria-pressed', E.comparando ? 'true' : 'false');
    $('#cmp-comparar').textContent = E.comparando ? 'Voltar ao cenário' : 'Comparar cenários';
  }

  function renderAcao() {
    var box = $('#cmp-acao'); box.textContent = ''; box.hidden = true;
    var c = atual();
    if (E.acao === 'renomear' && c) {
      box.hidden = false;
      var f = el('form', { class: 'linha-acao' });
      add(f, el('label', { for: 'cmp-novo-nome' }, 'Novo nome'), el('input', { id: 'cmp-novo-nome', type: 'text', value: c.nome, maxlength: '80', autocomplete: 'off' }),
        el('button', { class: 'btn prim', type: 'submit' }, 'Salvar nome'), el('button', { class: 'btn', type: 'button', id: 'cmp-cancela-acao' }, 'Cancelar'));
      f.addEventListener('submit', function (e) { e.preventDefault(); renomear($('#cmp-novo-nome').value); });
      box.appendChild(f);
    } else if (E.acao === 'excluir' && c) {
      box.hidden = false; box.classList.add('perigo');
      add(box, el('span', null, 'Excluir o cenário "' + c.nome + '"? Você pode desfazer logo em seguida.'),
        el('button', { class: 'btn perigo', type: 'button', id: 'cmp-confirma-excluir' }, 'Excluir cenário'),
        el('button', { class: 'btn', type: 'button', id: 'cmp-cancela-acao' }, 'Cancelar'));
      $('#cmp-confirma-excluir').addEventListener('click', excluir);
    } else if (E.desfazer) {
      box.hidden = false;
      add(box, el('span', null, E.desfazer.texto), el('button', { class: 'btn', type: 'button', id: 'cmp-desfazer' }, 'Desfazer'));
      $('#cmp-desfazer').addEventListener('click', function () { E.desfazer.fn(); });
    }
    if (E.acao !== 'excluir') box.classList.remove('perigo');
    var canc = $('#cmp-cancela-acao'); if (canc) canc.addEventListener('click', function () { E.acao = null; renderAcao(); });
  }

  function renderBanner() {
    var b = $('#cmp-banner'); b.textContent = ''; b.hidden = true; b.className = 'faixa';
    var c = atual();
    if (c && c.exemplo) {
      b.hidden = false; b.classList.add('exemplo');
      add(b, el('strong', null, 'Exemplo — dados fictícios.'),
        el('span', null, ' Emissores e taxas inventados para demonstração, com mercado fixo de ' + dataBR(c.mercadoFixo.coletadoEm) + '. Edições aqui não são salvas.'),
        el('button', { class: 'btn', type: 'button', id: 'cmp-sair-ex' }, 'Sair do exemplo'));
      $('#cmp-sair-ex').addEventListener('click', sairExemplo);
    } else if (c && c.referencia) {
      b.hidden = false; b.classList.add('referencia');
      add(b, el('strong', null, E.referencia.provisorio ? 'Cenário de referência provisório.' : 'Cenário de referência.'),
        el('span', null, ' ' + E.referencia.descricao + ' Mercado fixo de ' + dataBR(c.mercadoFixo.coletadoEm) + '; não pode ser editado.'));
    }
  }

  /* ---------- parâmetros do cenário ---------- */
  function renderParametros(c, R) {
    var box = $('#cmp-param'); box.textContent = '';
    var trava = grupo(c) === 'referencia';
    var cab = el('div', { class: 'cab-cenario' });
    add(cab, el('h2', { id: 'cmp-nome' }, c.nome));
    var acoes = el('div', { class: 'acoes' });
    if (grupo(c) === 'meu') {
      var s = el('button', { class: 'btn prim', type: 'button', id: 'cmp-salvar' }, sujo(c) ? 'Salvar cenário' : 'Salvo');
      s.disabled = !sujo(c);
      s.addEventListener('click', salvarAtual);
      acoes.appendChild(s);
      if (sujo(c)) {
        var dsc = el('button', { class: 'btn', type: 'button', id: 'cmp-descartar' }, E.rascunhos[c.id]._novo ? 'Descartar cenário' : 'Descartar alterações');
        dsc.addEventListener('click', descartar); acoes.appendChild(dsc);
        acoes.appendChild(el('span', { class: 'chip-nsalvo' }, 'Alterações não salvas'));
      }
    }
    cab.appendChild(acoes);
    box.appendChild(cab);

    var g = el('div', { class: 'campos' });
    g.appendChild(campo('cmp-valor', 'Valor inicial (R$)', c.valor == null ? '' : nf(c.valor, 2), 'ex.: 50.000,00', trava, function (v) { setC('valor', lerNumero(v, true)); }, true));
    g.appendChild(campo('cmp-aporte', 'Aporte mensal (R$, opcional)', c.aporteMensal == null ? '' : nf(c.aporteMensal, 2), 'deixe vazio se não houver', trava, function (v) { setC('aporteMensal', lerNumero(v, true)); }, true));
    var fd = el('div', { class: 'campo' });
    add(fd, el('label', { for: 'cmp-data' }, 'Data de aplicação'));
    var id = el('input', { id: 'cmp-data', type: 'date', value: c.dataInicio || '' }); id.disabled = trava;
    id.addEventListener('change', function () { setC('dataInicio', id.value || null, true); });
    fd.appendChild(id); g.appendChild(fd);
    g.appendChild(campo('cmp-prazo', 'Prazo (dias corridos)', c.prazoDias == null ? '' : String(c.prazoDias), 'ex.: 720', trava, function (v) { var n = lerNumero(v); setC('prazoDias', n == null ? null : Math.round(n)); }, true));
    box.appendChild(g);

    var info = el('p', { class: 'deriva', id: 'cmp-deriva', 'aria-live': 'polite' });
    box.appendChild(info);
    preencherDeriva(info, R);
  }
  function preencherDeriva(info, R) {
    info.textContent = '';
    if (R.faltasCenario.length) { add(info, el('span', { class: 'ausente' }, '⚠ falta ' + R.faltasCenario.join(', '))); return; }
    var meses = R.dc / 30.4375;
    add(info, R.dc + ' dias ≈ ' + nf(meses, 1) + ' meses · resgate em ' + dataBR(R.dataResgate) + ' (' + DIAS_SEMANA[diaSemana(R.dataResgate)] + ') · ' +
      R.du + ' dias úteis · IR ' + pct(R.aliqIR, 1) + (R.aliqIR !== R.aliqRegra ? ' (editado)' : '') + ' nos tributados' + (R.aliqIOF > 0 ? ' · IOF ' + pct(R.aliqIOF, 0) + ' onde incide' : '') +
      (R.fluxos.length > 1 ? ' · ' + (R.fluxos.length - 1) + ' aportes mensais' : ''));
  }
  function campo(id, rotulo, valor, ph, trava, onInput, numero) {
    var f = el('div', { class: 'campo' });
    add(f, el('label', { for: id }, rotulo));
    var i = el('input', { id: id, type: 'text', value: valor, placeholder: ph, autocomplete: 'off', inputmode: numero ? 'decimal' : null });
    i.disabled = !!trava;
    i.addEventListener('input', function () { onInput(i.value); });
    f.appendChild(i);
    return f;
  }

  /* Altera o cenário e recalcula só os resultados (os campos continuam com o foco). */
  function setC(k, v, rerenderTudo) {
    var c = editavel(); if (!c) return;
    c[k] = v;
    if (rerenderTudo) { render(); return; }
    atualizarResultados();
  }
  function setP(i, k, v, rerenderTudo) {
    var c = editavel(); if (!c) return;
    c.produtos[i][k] = v;
    if (rerenderTudo) { var foco = document.activeElement && document.activeElement.id; render(); if (foco && document.getElementById(foco)) document.getElementById(foco).focus(); return; }
    atualizarResultados();
  }
  /* semPremissas: a edição veio do próprio painel de premissas; não o redesenha para não tirar o foco. */
  function atualizarResultados(semPremissas) {
    var c = atual(), R = calcular(c);
    preencherDeriva($('#cmp-deriva'), R);
    renderVeredito(c, R);
    renderResultadoTabela(c, R);
    if (!semPremissas) renderPremissas(c, R);
    renderMemoria(c, R);
    var s = $('#cmp-salvar');
    if (s && grupo(c) === 'meu' && s.disabled) { renderParametrosSoBotoes(c); renderBarra(); }
  }
  function renderParametrosSoBotoes(c) {
    var cab = $('#cmp-param .cab-cenario .acoes'); if (!cab) return;
    cab.textContent = '';
    var s = el('button', { class: 'btn prim', type: 'button', id: 'cmp-salvar' }, 'Salvar cenário');
    s.addEventListener('click', salvarAtual);
    var dsc = el('button', { class: 'btn', type: 'button', id: 'cmp-descartar' }, E.rascunhos[c.id] && E.rascunhos[c.id]._novo ? 'Descartar cenário' : 'Descartar alterações');
    dsc.addEventListener('click', descartar);
    add(cab, s, dsc, el('span', { class: 'chip-nsalvo' }, 'Alterações não salvas'));
  }

  /* ---------- veredito ---------- */
  function renderVeredito(c, R) {
    var box = $('#cmp-veredito'); box.textContent = ''; box.className = 'veredito';
    var ok = R.ranking || [];
    if (R.faltasCenario.length) {
      box.classList.add('pendente');
      add(box, el('p', { class: 'v-titulo' }, 'Preencha o cenário para comparar'), el('p', null, 'Falta: ' + R.faltasCenario.join(', ') + '.'));
      return;
    }
    if (ok.length < 2) {
      box.classList.add('pendente');
      var fora = R.produtos.filter(function (x) { return !x.ok; });
      add(box, el('p', { class: 'v-titulo' }, ok.length === 1 ? 'Só um produto completo: ' + ok[0].nome + ' termina com ' + reais(ok[0].r.final) : 'Nenhum produto completo ainda'),
        el('p', null, fora.length ? 'Para comparar, complete: ' + fora.map(function (x) { return x.nome + ' (' + x.faltas.join('; ') + ')'; }).join(' · ') + '.' : 'Adicione um segundo produto.'));
      return;
    }
    var v = R.vencedor, s = R.segundo;
    add(box, el('p', { class: 'v-rotulo' }, 'Rende mais no líquido'));
    add(box, el('p', { class: 'v-titulo' }, v.nome));
    var linha = el('p', { class: 'v-linha' });
    add(linha, el('span', { class: 'num v-grande' }, reais(v.r.final)), ' em ' + R.dc + ' dias · ',
      el('strong', { class: 'num' }, '+ ' + reais(R.dif)), ' que o ' + s.nome + (R.difAA != null ? ' (' + pctPP(R.difAA) + ' ao ano)' : ''));
    box.appendChild(linha);
    if (R.dif < 0.005) box.appendChild(el('p', null, 'Empate técnico: diferença menor que um centavo.'));
    var tr = el('p', { class: 'v-troca' });
    if (R.trocas.length) add(tr, el('strong', null, 'O que você aceita em troca: '), R.trocas.join('; ') + '.');
    if (R.faltaRisco) add(tr, el('span', { class: 'ausente' }, (R.trocas.length ? ' ' : '') + '⚠ Informe emissor e liquidez dos dois primeiros para ver o que se perde em risco e liquidez.'));
    else if (!R.trocas.length) add(tr, el('strong', null, 'Risco e liquidez: '), 'o vencedor não fica atrás do ' + s.nome + ' em FGC, liquidez ou marcação a mercado nos dados informados.');
    box.appendChild(tr);
    if (R.equilibrio) {
      var q = R.equilibrio, atualCDI = R.pr.cdiAA.valor;
      var cmp = q.pos === v ? 'abaixo' : 'acima';
      var lado = q.pos === v ? q.outro.nome + ' passa à frente' : q.pos.nome + ' passa à frente';
      add(box, el('p', { class: 'v-sens' }, 'Sensibilidade: o cálculo usa CDI constante de ' + pct(atualCDI) + ' a.a. Se o CDI médio do período ficar ' + cmp + ' de ' +
        pct(q.cdi) + ' a.a., o ' + lado + '.' + (q.ipca ? ' (Com o IPCA projetado mantido em ' + pct(R.pr.ipcaProjAA.valor) + ' a.a.)' : '') +
        focusTexto(R)));
    }
    var fora2 = R.produtos.filter(function (x) { return !x.ok; });
    if (fora2.length) box.appendChild(el('p', { class: 'ausente' }, '⚠ Fora da comparação: ' + fora2.map(function (x) { return x.nome + ' (' + x.faltas.join('; ') + ')'; }).join(' · ')));
  }
  function focusTexto() {
    var m = atual().mercadoFixo || E.mercado, s = (m && m.series) || {};
    if (!s.focusSelic) return '';
    var t = ' O Focus de ' + dataBR(s.focusSelic.data) + ' projeta Selic de ' + nf(s.focusSelic.valor, 2) + '% no fim de ' + s.focusSelic.nome.slice(-4);
    if (s.focusSelicProx) t += ' e ' + nf(s.focusSelicProx.valor, 2) + '% no fim de ' + s.focusSelicProx.nome.slice(-4);
    return t + '.';
  }

  /* ---------- uma caixa por produto (F1.2, referência: calculadora da Rico) ----------
     Cada caixa: nome e selo "Rende mais" → dados do produto → valor bruto, IR e valor líquido sempre à vista →
     "Detalhes" (DRE completa, rentabilidade, riscos e pendências). Os campos não são redesenhados ao digitar:
     só o resultado de cada caixa (renderResultadoTabela), para não tirar o foco. */
  function campoCartao(rotulo, forId, controle, largo) {
    var f = el('div', { class: 'campo' + (largo ? ' largo' : '') });
    if (forId) f.appendChild(el('label', { for: forId }, rotulo)); else f.appendChild(el('span', { class: 'rot-campo' }, rotulo));
    f.appendChild(controle);
    return f;
  }
  function renderTabela(c, R) {
    var wrap = $('#cmp-tabela'); wrap.textContent = '';
    var trava = grupo(c) === 'referencia';
    var n = c.produtos.length;
    c.produtos.forEach(function (p, i) {
      var card = el('article', { class: 'cartao', id: 'cmp-card-' + i, 'aria-labelledby': 'cmp-p' + i + '-nome' });
      var cab = el('div', { class: 'cartao-cab' });
      var inp = el('input', { id: 'cmp-p' + i + '-nome', class: 'cartao-nome', type: 'text', value: p.nome || '', placeholder: 'Produto ' + (i + 1) + ' (nome)', 'aria-label': 'Nome do produto ' + (i + 1), autocomplete: 'off', maxlength: '60' });
      inp.disabled = trava;
      inp.addEventListener('input', function () { setP(i, 'nome', inp.value); });
      cab.appendChild(inp);
      var selo = el('span', { class: 'selo-ganho', id: 'cmp-selo-' + i }, 'Rende mais'); selo.hidden = true;
      cab.appendChild(selo);
      if (!trava && n > 1) {
        var rm = el('button', { class: 'btn-icone', type: 'button', 'aria-label': 'Remover ' + rotuloProduto(p, i), title: 'Remover produto' }, '×');
        rm.addEventListener('click', function () { var ce = editavel(); ce.produtos.splice(i, 1); render(); status('Produto removido. Descartar alterações desfaz.'); });
        cab.appendChild(rm);
      }
      card.appendChild(cab);

      var g = el('div', { class: 'cartao-campos' });
      // Tipo
      var sT = el('select', { id: 'cmp-p' + i + '-tipo', 'aria-label': 'Tipo do produto ' + (i + 1) });
      sT.disabled = trava;
      sT.appendChild(el('option', { value: '' }, 'Escolha…'));
      TIPOS.forEach(function (tp) { sT.appendChild(el('option', { value: tp.id }, tp.nome)); });
      sT.value = p.tipo || '';
      sT.addEventListener('change', function () {
        var ce = editavel(), pp = ce.produtos[i]; pp.tipo = sT.value;
        var ok = tipoDe(sT.value);
        if (ok && ok.ix.indexOf(pp.indexador) < 0) pp.indexador = ok.ix.length === 1 ? ok.ix[0] : '';
        if (sT.value === 'POUPANCA') pp.indexador = '';
        render(); var f = document.getElementById('cmp-p' + i + '-tipo'); if (f) f.focus();
      });
      g.appendChild(campoCartao('Tipo', 'cmp-p' + i + '-tipo', sT));
      // Indexador
      var tp = tipoDe(p.tipo);
      if (p.tipo === 'POUPANCA') g.appendChild(campoCartao('Indexador', null, el('span', { class: 'fixo' }, '0,5% a.m. + TR (Selic > 8,5%) ou 70% da Selic + TR'), true));
      else if (!tp) g.appendChild(campoCartao('Indexador', null, el('span', { class: 'fixo' }, 'escolha o tipo')));
      else {
        var sI = el('select', { id: 'cmp-p' + i + '-ix', 'aria-label': 'Indexador do produto ' + (i + 1) });
        sI.disabled = trava;
        if (tp.ix.length > 1) sI.appendChild(el('option', { value: '' }, 'Escolha…'));
        tp.ix.forEach(function (x) { sI.appendChild(el('option', { value: x }, IX[x].nome)); });
        sI.value = p.indexador || '';
        sI.addEventListener('change', function () { setP(i, 'indexador', sI.value, true); });
        g.appendChild(campoCartao('Indexador', 'cmp-p' + i + '-ix', sI));
      }
      // Taxa (o rótulo visível faz parte do nome acessível: WCAG 2.5.3)
      if (p.tipo === 'POUPANCA') g.appendChild(campoCartao('Taxa', null, el('span', { class: 'fixo' }, 'definida por lei')));
      else if (IX[p.indexador]) {
        var ix = IX[p.indexador];
        g.appendChild(campoCartao('Taxa', 'cmp-p' + i + '-taxa', entradaNumero('cmp-p' + i + '-taxa', 'Taxa (' + ix.rotulo + ') do produto ' + (i + 1), p[ix.campo], ix.ph, trava, ix.prefixo, ix.sufixo,
          function (v) { setP(i, ix.campo, v); }, function (v) { return interpretarTaxa(p.indexador, v); }), true));
      }
      // Emissor
      if (p.tipo === 'TESOURO') g.appendChild(campoCartao('Emissor', null, el('span', { class: 'fixo' }, 'Tesouro Nacional')));
      else {
        var iE = el('input', { id: 'cmp-p' + i + '-emissor', type: 'text', value: p.emissor || '', placeholder: p.tipo === 'POUPANCA' ? 'banco' : 'banco ou empresa', autocomplete: 'off', 'aria-label': 'Emissor do produto ' + (i + 1) });
        iE.disabled = trava;
        iE.addEventListener('input', function () { setP(i, 'emissor', iE.value); });
        g.appendChild(campoCartao('Emissor', 'cmp-p' + i + '-emissor', iE));
      }
      // Liquidez
      if (p.tipo === 'TESOURO' || p.tipo === 'POUPANCA') g.appendChild(campoCartao('Liquidez', null, el('span', { class: 'fixo' }, 'Diária')));
      else {
        var w = el('div', { class: 'liq' });
        var sL = el('select', { id: 'cmp-p' + i + '-liq', 'aria-label': 'Liquidez do produto ' + (i + 1) });
        sL.disabled = trava;
        sL.appendChild(el('option', { value: '' }, 'Escolha…'));
        LIQUIDEZ.forEach(function (l) { sL.appendChild(el('option', { value: l.id }, l.nome)); });
        sL.value = p.liquidez || '';
        sL.addEventListener('change', function () { setP(i, 'liquidez', sL.value, true); });
        w.appendChild(sL);
        g.appendChild(campoCartao('Liquidez', 'cmp-p' + i + '-liq', w));
        if (p.liquidez === 'carencia') {
          g.appendChild(campoCartao('Carência em dias', 'cmp-p' + i + '-car', entradaNumero('cmp-p' + i + '-car', 'Carência em dias do produto ' + (i + 1), p.carenciaDias, 'ex.: 90', trava, null, 'dias',
            function (v) { setP(i, 'carenciaDias', v == null || isNaN(v) ? null : Math.round(v)); }, null, 0)));
        }
      }
      // Custódia (Tesouro) ou taxa de administração (fundo)
      if (p.tipo === 'TESOURO') g.appendChild(campoCartao('Taxa de custódia', 'cmp-p' + i + '-cust', entradaNumero('cmp-p' + i + '-cust', 'Taxa de custódia do produto ' + (i + 1), p.custodiaAA, 'ex.: 0,20', trava, null, '% a.a.', function (v) { setP(i, 'custodiaAA', v); }), true));
      if (ehFundo(p.tipo)) g.appendChild(campoCartao('Taxa de administração', 'cmp-p' + i + '-adm', entradaNumero('cmp-p' + i + '-adm', 'Taxa de administração do produto ' + (i + 1), p.taxaAdmAA, 'ex.: 0,50', trava, null, '% a.a.', function (v) { setP(i, 'taxaAdmAA', v); }), true));
      card.appendChild(g);

      card.appendChild(el('div', { class: 'cartao-res', id: 'cmp-res-' + i, 'aria-live': 'polite' }));
      var det = el('details', { class: 'detalhes', id: 'cmp-det-' + i });
      det.open = !!E.detAberto;
      det.appendChild(el('summary', null, 'Detalhes'));
      det.appendChild(el('div', { class: 'det-corpo', id: 'cmp-detc-' + i }));
      // Abrir os detalhes de uma caixa abre os das outras: as linhas ficam lado a lado para comparar.
      det.addEventListener('toggle', function () {
        if (E.detAberto === det.open) return;
        E.detAberto = det.open;
        wrap.querySelectorAll('details.detalhes').forEach(function (d) { if (d !== det && d.open !== det.open) d.open = det.open; });
      });
      card.appendChild(det);
      wrap.appendChild(card);
    });
    if (!trava && n < 3) {
      var b = el('button', { class: 'cartao-novo', type: 'button', id: 'cmp-add-prod' }, '+ Adicionar produto (' + n + ' de 3)');
      b.addEventListener('click', function () { var ce = editavel(); ce.produtos.push(produtoVazio()); render(); var f = document.getElementById('cmp-p' + n + '-tipo'); if (f) f.focus(); });
      wrap.appendChild(b);
    }
    renderResultadoTabela(c, R);
  }

  function interpretarTaxa(ix, v) {
    if (v == null || isNaN(v)) return null;
    if (ix === 'CDI' && v > 0 && v < 20) return { alerta: true, t: '= ' + nf(v, 2) + '% do CDI. Você quis ' + nf(v * 100, 0) + '%?' };
    if (ix === 'CDI') return { t: '= ' + nf(v, 2) + '% do CDI' };
    if ((ix === 'PRE') && v > 0 && v < 1) return { alerta: true, t: '= ' + nf(v, 2) + '% a.a. Você quis ' + nf(v * 100, 2) + '%?' };
    return null;
  }

  function entradaNumero(id, aria, valor, ph, trava, prefixo, sufixo, onVal, interpretar, dec) {
    var w = el('div', { class: 'num-in' });
    var linhaIn = el('div', { class: 'num-linha' });
    if (prefixo) linhaIn.appendChild(el('span', { class: 'afixo' }, prefixo.trim()));
    var i = el('input', { id: id, type: 'text', inputmode: 'decimal', value: valor == null ? '' : nf(valor, dec == null ? 2 : dec), placeholder: ph, 'aria-label': aria, autocomplete: 'off' });
    i.disabled = !!trava;
    linhaIn.appendChild(i);
    if (sufixo) linhaIn.appendChild(el('span', { class: 'afixo' }, sufixo));
    w.appendChild(linhaIn);
    var dica = el('span', { class: 'dica', 'aria-live': 'polite' });
    w.appendChild(dica);
    function mostrar(v) {
      dica.textContent = ''; dica.className = 'dica';
      if (i.value && isNaN(v)) { dica.textContent = 'Use só números, com vírgula ou ponto.'; dica.classList.add('alerta'); return; }
      var x = interpretar && interpretar(v);
      if (x) { dica.textContent = x.t; if (x.alerta) dica.classList.add('alerta'); }
    }
    mostrar(lerNumero(valor == null ? '' : String(valor).replace('.', ',')));
    i.addEventListener('input', function () { var v = lerNumero(i.value); mostrar(v); onVal(v); });
    return w;
  }

  /* Tabela da comparação entre cenários (renderComparacao). */
  function secao(tb, titulo, n) {
    var tr = el('tr', { class: 'secao' });
    tr.appendChild(el('th', { scope: 'colgroup', colspan: String(n + 1) }, titulo));
    tb.appendChild(tr);
  }
  function linha(tb, rotulo, celulas, cls, nota) {
    var tr = el('tr', cls ? { class: cls } : null);
    var h = el('th', { scope: 'row', class: 'rot' }, rotulo);
    if (nota) h.appendChild(el('span', { class: 'nota' }, nota));
    tr.appendChild(h);
    celulas.forEach(function (cel, i) {
      var td = el('td', { class: 'prod' });
      if (cel && cel.nodeType) td.appendChild(cel);
      else if (cel && cel.html) { td.appendChild(cel.html); if (cel.cls) td.className += ' ' + cel.cls; }
      else td.textContent = cel == null ? '—' : cel;
      tr.appendChild(td);
    });
    tb.appendChild(tr);
    return tr;
  }

  /* Linha "rótulo ........ valor" dos resultados e dos detalhes. */
  function resLinha(pai, rotulo, valor, nota, cls) {
    var d = el('div', { class: 'res-linha' + (cls ? ' ' + cls : '') });
    var r = el('span', { class: 'rot' }, rotulo); if (nota) r.appendChild(el('small', null, nota));
    d.appendChild(r);
    d.appendChild(valor && valor.nodeType ? valor : el('span', { class: 'num' }, valor == null ? '—' : valor));
    pai.appendChild(d);
  }
  function detLinha(dl, rotulo, valor, nota, cls) {
    var d = el('div', cls ? { class: cls } : null);
    var dt = el('dt', null, rotulo); if (nota) dt.appendChild(el('small', null, nota));
    var dd = el('dd');
    // Valor curto (dinheiro, %) não quebra; frase longa quebra dentro da coluna.
    if (valor && valor.nodeType) dd.appendChild(valor); else { var tv = valor == null ? '—' : String(valor); dd.appendChild(el('span', { class: tv.length > 18 ? 'num frase' : 'num' }, tv)); }
    add(d, dt, dd); dl.appendChild(d);
  }
  function detGrupo(pai, titulo, texto) {
    var gp = el('div', { class: 'det-grupo' });
    gp.appendChild(el('h4', null, titulo));
    var dl = el('dl', { class: 'det-lista' + (texto ? ' texto' : '') });
    gp.appendChild(dl); pai.appendChild(gp);
    return dl;
  }

  function renderResultadoTabela(c, R) {
    var P = R.produtos;
    var vid = (!R.faltasCenario.length && R.vencedor) ? R.vencedor.i : -1;
    function neg(v) { var s = el('span', { class: 'num' + (v > 0.004 ? ' neg' : '') }); s.textContent = v > 0.004 ? '− ' + reais(v) : reais(0); return s; }
    P.forEach(function (x, k) {
      var i = x.i != null ? x.i : k;
      var card = document.getElementById('cmp-card-' + i), res = document.getElementById('cmp-res-' + i), dc = document.getElementById('cmp-detc-' + i), selo = document.getElementById('cmp-selo-' + i);
      if (!card || !res || !dc) return;
      res.textContent = ''; dc.textContent = '';
      var venc = i === vid;
      card.classList.toggle('vencedor', venc);
      if (selo) selo.hidden = !venc;
      if (R.faltasCenario.length) {
        res.appendChild(el('p', { class: 'res-falta ausente' }, '⚠ falta ' + R.faltasCenario.join(', ') + ' do cenário. Preencha acima para ver o resultado.'));
        dc.appendChild(el('p', { class: 'muted pequeno' }, 'Os detalhes aparecem quando o cenário estiver completo.'));
        return;
      }
      if (!x.ok) {
        res.appendChild(el('p', { class: 'res-falta ausente' }, x.faltas.length ? '⚠ falta ' + x.faltas.join('; ') : '⚠ produto incompleto'));
        dc.appendChild(el('p', { class: 'muted pequeno' }, 'Os detalhes aparecem quando o produto estiver completo.'));
        return;
      }
      var r = x.r;
      // Sempre à vista: bruto, IR (e IOF/custos quando houver) e líquido.
      var tIR = isento(x.p.tipo) ? 'isento' : ehFundo(x.p.tipo) ? 'come-cotas + complemento' : (x.aliqIRMin === x.aliqIRMax ? pct(x.aliqIRMax, 1) : pct(x.aliqIRMin, 1) + ' a ' + pct(x.aliqIRMax, 1));
      resLinha(res, 'Valor bruto', reais(x.capital + r.rendBruto), 'investido + rendimento bruto');
      if (r.iof > 0.004) resLinha(res, 'IOF', neg(r.iof), x.aliqIOFMax > 0 ? pct(x.aliqIOFMax, 0) : null);
      resLinha(res, 'Imposto de renda', neg(r.ir), tIR);
      if ((r.custos || 0) > 0.004) resLinha(res, x.p.tipo === 'TESOURO' ? 'Custódia' : 'Custos', neg(r.custos));
      resLinha(res, 'Valor líquido', reais(r.final), null, 'final');
      res.appendChild(el('p', { class: 'res-extra num' }, 'Rendimento líquido ' + reais(r.rendLiquido) + ' · ' + pct(x.rentPeriodo) + ' no período' + (R.fluxos.length === 1 && x.aa252 != null ? ' · ' + pct(x.aa252) + ' a.a.' : '')));

      // Detalhes: DRE completa, rentabilidade, riscos e pendências.
      var dre = detGrupo(dc, 'DRE do investimento');
      detLinha(dre, '(+) Aporte inicial', reais(R.fluxos[0].valor));
      if (R.fluxos.length > 1) detLinha(dre, '(+) Aportes mensais acumulados', reais(x.aportesMensais));
      detLinha(dre, '(=) Capital investido', reais(x.capital), null, 'subtotal');
      detLinha(dre, '(+) Rendimento bruto', reais(r.rendBruto));
      detLinha(dre, '(−) IOF', neg(r.iof), !M.temIOF(x.p.tipo) ? 'alíquota zero' : (x.aliqIOFMax > 0 ? pct(x.aliqIOFMax, 0) : '0% (≥ 30 dias)'));
      detLinha(dre, '(−) IR', neg(r.ir), tIR);
      if (ehFundo(x.p.tipo)) detLinha(dre, '(−) Taxa de administração / custódia', '—', 'embutida na cota');
      else detLinha(dre, '(−) Taxa de administração / custódia', neg(r.custos || 0));
      detLinha(dre, '(=) Rendimento líquido', reais(r.rendLiquido), null, 'subtotal');
      detLinha(dre, '(=) Patrimônio final', reais(r.final), null, 'subtotal');

      var rt = detGrupo(dc, 'Rentabilidade');
      detLinha(rt, 'Líquida no período', pct(x.rentPeriodo));
      if (R.fluxos.length === 1) detLinha(rt, 'Líquida ao ano', pct(x.aa252) + ' a.a.', 'base 252 dias úteis');
      detLinha(rt, 'TIR líquida', x.tir == null ? '—' : pct(x.tir) + ' a.a.', 'base 365 dias corridos');
      if (R.fluxos.length === 1) detLinha(rt, 'Equivalente exato em % do CDI', x.pctCDIEq == null ? '⚠ falta CDI' : nf(x.pctCDIEq * 100, 1) + '% do CDI', 'quanto um CDB tributado precisaria pagar para terminar com o mesmo valor');
      detLinha(rt, 'Gross-up pela fórmula', x.grossUp ? x.grossUp.texto : isento(x.p.tipo) ? '—' : 'tributado: não se aplica', 'taxa ÷ (1 − IR): regra de bolso; o exato fica acima');
      if (R.pr.ipcaProjAA.valor == null) detLinha(rt, 'Retorno real', '⚠ falta IPCA projetado');
      else {
        var w = el('span');
        if (x.realPeriodo != null) w.appendChild(el('span', { class: 'num bloco-num' }, pct(x.realPeriodo) + ' no período'));
        w.appendChild(el('span', { class: 'num bloco-num' }, x.realAA == null ? '—' : pct(x.realAA) + ' a.a.'));
        detLinha(rt, 'Retorno real', w, 'descontado IPCA projetado de ' + pct(R.pr.ipcaProjAA.valor) + ' a.a.');
      }
      var vpl;
      if (x.vpl == null) vpl = '⚠ falta CDI';
      else { vpl = el('span', { class: 'num' + (x.vpl < 0 ? ' neg' : '') }); vpl.textContent = (x.vpl < 0 ? '▼ ' : '') + reaisSinal(x.vpl); }
      detLinha(rt, 'VPL', vpl, R.pr.cdiAA.valor != null ? 'descontado pelo CDI líquido de IR do prazo (' + pct(R.pr.cdiAA.valor * (1 - R.aliqRegra)) + ' a.a.)' : null);
      detLinha(rt, 'Payback', el('span', { class: 'muted' }, 'não se aplica: o retorno vem só no resgate'));

      var rs = detGrupo(dc, 'Riscos', true);
      [['fgc', 'FGC'], ['emissor', 'Emissor'], ['liq', 'Liquidez / carência'], ['mam', 'Marcação a mercado']].forEach(function (kk) {
        var rr = x.riscos[kk[0]];
        detLinha(rs, kk[1], el('span', { class: rr.alerta ? 'ausente' : '' }, rr.t));
      });
      var l = x.faltas.slice();
      ['emissor', 'liq', 'fgc'].forEach(function (kk) { if (/falta|Verificar/.test(x.riscos[kk].t)) l.push(x.riscos[kk].t.replace(/^⚠ /, '')); });
      if (r) r.partes[0].notas.forEach(function (nn) { if (/Aproximação|embutida/.test(nn)) l.push(nn); });
      var pd = detGrupo(dc, 'Pendências', true);
      detLinha(pd, l.length ? '⚠ ' + l.length + (l.length === 1 ? ' pendência' : ' pendências') : 'Nenhuma pendência', el('span', { class: l.length ? 'ausente' : 'muted' }, l.length ? l.join(' · ') : 'todos os dados necessários foram informados'));
    });
  }

  /* ---------- conferência do cenário de referência ---------- */
  function renderConferencia(c, R) {
    var box = $('#cmp-conferencia'); box.textContent = ''; box.hidden = true;
    var rf = c.referencia && refDe(c.id);
    if (!rf) return;
    box.hidden = false;
    add(box, el('h3', null, rf.externo ? 'Conferência com o cálculo manual e com ' + rf.externo.fonte : 'Conferência com o cálculo manual'));
    var ok = true;
    var ul = el('ul');
    (rf.esperado || []).forEach(function (e) {
      var x = R.produtos[e.produto];
      var campos = ['rendBruto', 'iof', 'ir', 'custos', 'final'].filter(function (k) { return e[k] != null; });
      var dif = x && x.r ? Math.max.apply(null, campos.map(function (k) { return Math.abs((x.r[k] || 0) - e[k]); })) : null;
      var passou = dif != null && dif <= 0.01;
      ok = ok && passou;
      var li = el('li', { class: passou ? 'ok' : 'falha' });
      add(li, el('span', { class: 'marca-conf' }, passou ? '✓' : '✘'), ' ' + (x ? x.nome : 'Produto ' + (e.produto + 1)) + ': patrimônio final ' + reais(x && x.r ? x.r.final : null) +
        ' · cálculo manual ' + reais(e.final) + ' · maior diferença entre bruto, IOF, IR e final: ' + (dif == null ? '—' : reais(dif)));
      ul.appendChild(li);
      var ext = rf.externo && (rf.externo.valores || []).filter(function (v) { return v.produto === e.produto; })[0];
      if (ext) {
        var cx = ['rendBruto', 'iof', 'ir', 'final'].filter(function (k) { return ext[k] != null; });
        var dx = x && x.r ? Math.max.apply(null, cx.map(function (k) { return Math.abs((x.r[k] || 0) - ext[k]); })) : null;
        var px = dx != null && dx <= rf.externo.tolerancia + 1e-9;
        ok = ok && px;
        var li2 = el('li', { class: px ? 'ok' : 'falha' });
        add(li2, el('span', { class: 'marca-conf' }, px ? '✓' : '✘'), ' ' + rf.externo.fonte + ': patrimônio final ' + reais(ext.final) +
          ' · maior diferença: ' + (dx == null ? '—' : reais(dx)) + ' (tolerância ' + reais(rf.externo.tolerancia) + ', a calculadora corta os centavos)');
        ul.appendChild(li2);
      }
    });
    box.appendChild(ul);
    if (rf.memoria) box.appendChild(el('p', { class: 'muted' }, 'Cálculo manual: ' + rf.memoria));
    box.appendChild(el('p', { class: 'muted' }, E.referencia.metodo));
    box.className = 'conferencia ' + (ok ? 'ok' : 'falha');
  }

  /* ---------- painel de premissas ---------- */
  function renderPremissas(c, R) {
    var box = $('#cmp-premissas'); box.textContent = '';
    var trava = grupo(c) === 'referencia';
    var t = el('table', { class: 'prem' });
    var h = el('thead'); var hr = el('tr');
    ['Premissa', 'Valor usado', 'Fonte e data', 'Situação', ''].forEach(function (x, i) { hr.appendChild(el('th', { scope: 'col', class: i === 1 ? 'v' : null }, x)); });
    h.appendChild(hr); t.appendChild(h);
    var tb = el('tbody');
    var unidades = { cdiAA: '% a.a.', selicAA: '% a.a.', selicMetaAA: '% a.a.', trAM: '% a.m.', ipcaProjAA: '% a.a.' };
    var dec = { trAM: 4, ipcaProjAA: 4 };
    PREMISSAS.forEach(function (k) {
      var p = R.pr[k];
      var tr = el('tr', { class: p.origem === 'editado' ? 'editada' : null });
      var th = el('th', { scope: 'row' }, p.nome); th.appendChild(el('span', { class: 'nota' }, p.usoEm)); tr.appendChild(th);
      var td = el('td', { class: 'v' });
      td.appendChild(entradaNumero('cmp-pr-' + k, p.nome + ' em ' + unidades[k], p.valor == null ? null : p.valor * 100, '⚠ falta', trava, null, unidades[k], function (v) {
        var ce = editavel(); if (!ce) return;
        ce.premissas = ce.premissas || {};
        if (v == null || isNaN(v)) delete ce.premissas[k]; else ce.premissas[k] = v / 100;
        atualizarResultados(true);
      }, null, dec[k] || 2));
      aoSair(td);
      tr.appendChild(td);
      tr.appendChild(el('td', null, p.fonte ? p.fonte + ' · ' + (p.projecao ? 'pesquisa de ' : '') + dataBR(p.data) : '—'));
      tr.appendChild(add(el('td'), chipOrigem(p)));
      var tdB = el('td');
      if (p.origem === 'editado' && !trava) {
        var b = el('button', { class: 'btn mini', type: 'button' }, 'Usar ' + (c.mercadoFixo ? 'valor fixo' : 'mercado'));
        b.addEventListener('click', function () { var ce = editavel(); delete ce.premissas[k]; render(); });
        tdB.appendChild(b);
      }
      tr.appendChild(tdB);
      tb.appendChild(tr);
    });
    // Dias úteis
    if (!R.faltasCenario.length) {
      var trD = el('tr', { class: c.duEditado != null ? 'editada' : null });
      var thD = el('th', { scope: 'row' }, 'Dias úteis'); thD.appendChild(el('span', { class: 'nota' }, 'juros pós e pré (base 252)')); trD.appendChild(thD);
      var tdD = el('td', { class: 'v' });
      tdD.appendChild(entradaNumero('cmp-pr-du', 'Dias úteis', R.du, '', trava, null, 'du', function (v) {
        var ce = editavel(); if (!ce) return; ce.duEditado = v == null || isNaN(v) ? null : Math.round(v); atualizarResultados(true);
      }, null, 0));
      aoSair(tdD);
      trD.appendChild(tdD);
      trD.appendChild(el('td', null, E.feriados ? 'Calendário ANBIMA (feriados nacionais) · ' + R.duCalendario + ' du de ' + dataBR(c.dataInicio) + ' a ' + dataBR(R.dataResgate) : '⚠ calendário não carregou: seg. a sex.'));
      trD.appendChild(add(el('td'), c.duEditado != null ? chip('Editado', 'editado') : chip('Calculado', 'mercado')));
      var tdDB = el('td');
      if (c.duEditado != null && !trava) { var bd = el('button', { class: 'btn mini', type: 'button' }, 'Usar calendário'); bd.addEventListener('click', function () { editavel().duEditado = null; render(); }); tdDB.appendChild(bd); }
      trD.appendChild(tdDB); tb.appendChild(trD);

      var trI = el('tr', { class: c.aliqIREditada != null ? 'editada' : null });
      var thI = el('th', { scope: 'row' }, 'Alíquota de IR'); thI.appendChild(el('span', { class: 'nota' }, 'produtos tributados (aporte inicial)')); trI.appendChild(thI);
      var tdI = el('td', { class: 'v' });
      tdI.appendChild(entradaNumero('cmp-pr-ir', 'Alíquota de IR', R.aliqIR * 100, '', trava, null, '%', function (v) {
        var ce = editavel(); if (!ce) return; ce.aliqIREditada = v == null || isNaN(v) ? null : v / 100; atualizarResultados(true);
      }, null, 1));
      aoSair(tdI);
      trI.appendChild(tdI);
      trI.appendChild(el('td', null, 'Tabela regressiva, Lei 11.033/2004 · ' + R.dc + ' dias → ' + pct(R.aliqRegra, 1) + ' · regras verificadas em ' + dataBR(D.REGRAS_VERIFICADAS)));
      trI.appendChild(add(el('td'), c.aliqIREditada != null ? chip('Editado', 'editado') : chip('Regra', 'mercado')));
      var tdIB = el('td');
      if (c.aliqIREditada != null && !trava) { var bi = el('button', { class: 'btn mini', type: 'button' }, 'Usar tabela'); bi.addEventListener('click', function () { editavel().aliqIREditada = null; render(); }); tdIB.appendChild(bi); }
      trI.appendChild(tdIB); tb.appendChild(trI);

      var trO = el('tr');
      var thO = el('th', { scope: 'row' }, 'IOF'); thO.appendChild(el('span', { class: 'nota' }, 'resgate antes de 30 dias')); trO.appendChild(thO);
      trO.appendChild(el('td', { class: 'v num' }, pct(R.aliqIOF, 0) + ' do rendimento'));
      trO.appendChild(el('td', null, 'Tabela regressiva, Decreto 6.306/2007 · incide antes do IR'));
      trO.appendChild(add(el('td'), chip('Regra', 'mercado'))); trO.appendChild(el('td'));
      tb.appendChild(trO);
    }
    t.appendChild(tb);
    var w = el('div', { class: 'tabela-wrap' }); w.appendChild(t); box.appendChild(w);
    var m = c.mercadoFixo || E.mercado, s = (m && m.series) || {};
    var ctx = [];
    if (s.focusIpca) ctx.push('IPCA ' + s.focusIpca.nome.slice(-4) + ' ' + nf(s.focusIpca.valor, 2) + '%');
    if (s.focusIpcaProx) ctx.push('IPCA ' + s.focusIpcaProx.nome.slice(-4) + ' ' + nf(s.focusIpcaProx.valor, 2) + '%');
    if (s.focusSelic) ctx.push('Selic fim de ' + s.focusSelic.nome.slice(-4) + ' ' + nf(s.focusSelic.valor, 2) + '%');
    if (s.focusSelicProx) ctx.push('Selic fim de ' + s.focusSelicProx.nome.slice(-4) + ' ' + nf(s.focusSelicProx.valor, 2) + '%');
    var p = el('p', { class: 'muted pequeno' });
    p.textContent = 'O CDI e a Selic ficam constantes no período (premissa). O IPCA projetado é a mediana do Focus para os próximos 12 meses e vale para o prazo todo.' +
      (ctx.length ? ' Para prazos longos, compare com o Focus anual de ' + dataBR((s.focusIpca || s.focusSelic).data) + ': ' + ctx.join(' · ') + '. Edite a premissa para testar.' : '');
    box.appendChild(p);
    if (R.avisos.length) R.avisos.forEach(function (a) { box.appendChild(el('p', { class: 'ausente pequeno' }, '⚠ ' + a)); });
    var nEd = PREMISSAS.filter(function (k) { return R.pr[k].origem === 'editado'; }).length + (c.duEditado != null) + (c.aliqIREditada != null);
    var resumo = $('#cmp-prem-resumo');
    resumo.textContent = nEd ? nEd + ' editada' + (nEd > 1 ? 's' : '') : (c.mercadoFixo ? 'mercado fixo de ' + dataBR(c.mercadoFixo.coletadoEm) : 'dados de mercado de ' + (E.mercado && E.mercado.coletadoEm ? dataBR(E.mercado.coletadoEm.slice(0, 10)) : '—'));
    resumo.className = 'resumo-prem' + (nEd ? ' editado' : '');
    if (nEd) $('#cmp-prem-det').open = true;
  }
  /* Ao sair do campo, redesenha o painel para atualizar o destaque "Editado". */
  function aoSair(td) {
    var i = td.querySelector('input'); if (!i) return;
    i.addEventListener('change', function () { var c = atual(); if (c) renderPremissas(c, calcular(c)); });
  }
  function chip(t, cls) { return el('span', { class: 'chip-orig ' + cls }, t); }
  function chipOrigem(p) {
    if (p.valor == null) return el('span', { class: 'ausente' }, '⚠ falta');
    if (p.origem === 'editado') return chip('Editado', 'editado');
    if (p.origem === 'fixo') return chip('Fixo do cenário', 'fixo');
    if (p.origem === 'projecao') return chip('Projeção', 'projecao');
    return chip('Mercado', 'mercado');
  }

  /* ---------- memória de cálculo ---------- */
  function renderMemoria(c, R) {
    var box = $('#cmp-memoria'); box.textContent = '';
    if (R.faltasCenario.length) { box.appendChild(el('p', { class: 'muted' }, 'Preencha o cenário para ver a memória de cálculo.')); return; }
    R.produtos.forEach(function (x) {
      var d = el('div', { class: 'mem' });
      add(d, el('h4', null, x.nome));
      if (!x.ok) { d.appendChild(el('p', { class: 'ausente' }, '⚠ ' + x.faltas.join(' · '))); box.appendChild(d); return; }
      var ul = el('ul');
      var p = x.p, q = x.r.partes[0];
      ul.appendChild(el('li', null, 'Aplicação ' + dataBR(c.dataInicio) + ' → resgate ' + dataBR(R.dataResgate) + ': ' + q.dc + ' dias corridos (IR e IOF), ' + q.du + ' dias úteis (juros).'));
      ul.appendChild(el('li', null, formula(p, R)));
      ul.appendChild(el('li', null, 'Fator bruto do aporte inicial: ' + nf(1 + q.rendBruto / q.valor, 8) + ' → rendimento bruto ' + reais(q.rendBruto) + '.'));
      if (!isento(p.tipo) && !ehFundo(p.tipo)) ul.appendChild(el('li', null, 'IOF = rendimento × ' + pct(q.aliqIOF, 0) + ' = ' + reais(q.iof) + '; IR = (rendimento − IOF) × ' + pct(q.aliqIR, 1) + ' = ' + reais(q.ir) + '.'));
      if (R.fluxos.length > 1) ul.appendChild(el('li', null, R.fluxos.length + ' aportes, cada um com seu prazo e sua alíquota (o mais antigo sai primeiro).'));
      q.notas.forEach(function (nn) { ul.appendChild(el('li', null, nn.replace(/(\d+)\.(\d{2})\b/, function (m0, a, b) { return reais(Number(a + '.' + b)); }))); });
      d.appendChild(ul);
      box.appendChild(d);
    });
  }
  function formula(p, R) {
    var pr = R.pr;
    switch (p.tipo === 'POUPANCA' ? 'POUP' : p.indexador) {
      case 'CDI': return 'Pós-fixado: fator = (1 + ((1 + CDI)^(1/252) − 1) × ' + nf(p.pctCDI, 2) + '%)^du, com CDI ' + pct(pr.cdiAA.valor) + ' a.a.';
      case 'CDI_MAIS': return 'CDI + taxa: fator = (1 + CDI)^(du/252) × (1 + ' + nf(p.spreadAA, 2) + '%)^(du/252), com CDI ' + pct(pr.cdiAA.valor) + ' a.a.';
      case 'PRE': return 'Prefixado: fator = (1 + ' + nf(p.taxaAA, 2) + '%)^(du/252).';
      case 'IPCA': return 'IPCA+: fator = (1 + IPCA proj. ' + pct(pr.ipcaProjAA.valor) + ')^(dc/365) × (1 + ' + nf(p.jurosRealAA, 2) + '%)^(du/252). O IPCA é projeção.';
      case 'SELIC': return 'Tesouro Selic: fator = (1 + Selic over ' + pct(pr.selicAA.valor) + ')^(du/252) × (1 + ' + nf(p.spreadAA, 2) + '%)^(du/252).';
      case 'POUP': return 'Poupança: ' + (pr.selicMetaAA.valor > 0.085 ? '0,5% a.m. + TR (' + nf(pr.trAM.valor * 100, 4) + '% a.m.)' : '70% da Selic meta + TR') + ' por aniversário mensal completo; TR mantida constante.';
    }
    return '';
  }

  /* ---------- comparar cenários ---------- */
  function renderComparacao() {
    var box = $('#cmp-comparacao'); box.textContent = '';
    add(box, el('h2', null, 'Comparar cenários'), el('p', { class: 'sub' }, 'Escolha até 3 cenários do mesmo grupo. Cada coluna mostra o vencedor do cenário e o resultado dele.'));
    var grupos = [{ nome: 'Meus cenários', lista: todos() }];
    if (E.exemplos) grupos.push({ nome: 'Exemplo — dados fictícios', lista: E.exemplos });
    var fs = el('div', { class: 'escolha' });
    grupos.forEach(function (g) {
      if (!g.lista.length) return;
      var f = el('fieldset'); f.appendChild(el('legend', null, g.nome));
      g.lista.forEach(function (c) {
        var id = 'cmp-x-' + c.id, lb = el('label', { for: id, class: 'opcao' });
        var cb = el('input', { type: 'checkbox', id: id, value: c.id }); cb.checked = E.selecao.indexOf(c.id) >= 0;
        var outroGrupo = E.selecao.length && grupo(achar(E.selecao[0])) !== grupo(c);
        cb.disabled = !cb.checked && (E.selecao.length >= 3 || outroGrupo);
        cb.addEventListener('change', function () {
          if (cb.checked) E.selecao.push(c.id); else E.selecao = E.selecao.filter(function (x) { return x !== c.id; });
          renderComparacao();
        });
        add(lb, cb, ' ' + c.nome + (sujo(c) ? ' (não salvo)' : ''));
        f.appendChild(lb);
      });
      fs.appendChild(f);
    });
    box.appendChild(fs);
    if (E.selecao.length && grupo(achar(E.selecao[0])) === 'exemplo') box.appendChild(el('p', { class: 'faixa exemplo' }, 'Exemplo — dados fictícios.'));
    if (E.selecao.length < 2) { box.appendChild(el('p', { class: 'muted' }, 'Marque pelo menos dois cenários.')); return; }
    var guarda = E.atualId;
    var cols = E.selecao.map(function (id) { E.atualId = id; var c = achar(id); return { c: c, R: calcular(c) }; });
    E.atualId = guarda;
    var t = el('table', { class: 'dre comp' });
    var hr = el('tr'); hr.appendChild(el('th', { scope: 'col', class: 'rot' }, ''));
    cols.forEach(function (k) { hr.appendChild(el('th', { scope: 'col', class: 'prod' }, k.c.nome)); });
    var th = el('thead'); th.appendChild(hr); t.appendChild(th);
    var tb = el('tbody');
    function L(rot, fn) { linha(tb, rot, cols.map(function (k) { var v = fn(k); return { html: el('span', { class: 'num' }, v), cls: 'v' }; })); }
    L('Valor inicial', function (k) { return reais(k.c.valor); });
    L('Aporte mensal', function (k) { return k.c.aporteMensal ? reais(k.c.aporteMensal) : '—'; });
    L('Prazo', function (k) { return k.R.dc ? k.R.dc + ' dias (resgate ' + dataBR(k.R.dataResgate) + ')' : '⚠ falta prazo'; });
    L('Vencedor', function (k) { return k.R.vencedor ? k.R.vencedor.nome : (k.R.ranking && k.R.ranking[0] ? k.R.ranking[0].nome + ' (único completo)' : '⚠ incompleto'); });
    var top = function (k) { return k.R.ranking && k.R.ranking[0]; };
    L('Patrimônio final', function (k) { return top(k) ? reais(top(k).r.final) : '—'; });
    L('Rendimento líquido', function (k) { return top(k) ? reais(top(k).r.rendLiquido) : '—'; });
    L('TIR líquida', function (k) { return top(k) && top(k).tir != null ? pct(top(k).tir) + ' a.a.' : '—'; });
    L('Vantagem sobre o 2º', function (k) { return k.R.vencedor ? '+ ' + reais(k.R.dif) : '—'; });
    L('Dados de mercado', function (k) { return k.c.mercadoFixo ? 'fixo de ' + dataBR(k.c.mercadoFixo.coletadoEm) : 'atuais' + (Object.keys(k.c.premissas || {}).length ? ' + premissas editadas' : ''); });
    t.appendChild(tb);
    var w = el('div', { class: 'tabela-wrap' }); w.appendChild(t); box.appendChild(w);
  }

  /* ================= início ================= */
  async function iniciar() {
    $('#cmp-sel').addEventListener('change', function (e) { if (e.target.value) { E.comparando = false; selecionar(e.target.value); } });
    $('#cmp-novo').addEventListener('click', function () { E.comparando = false; novo(); });
    $('#cmp-vazio-novo').addEventListener('click', novo);
    $('#cmp-vazio-exemplo').addEventListener('click', carregarExemplo);
    $('#cmp-duplicar').addEventListener('click', duplicar);
    $('#cmp-renomear').addEventListener('click', pedirRenomear);
    $('#cmp-excluir').addEventListener('click', pedirExcluir);
    $('#cmp-exemplo').addEventListener('click', function () { if (E.exemplos) sairExemplo(); else carregarExemplo(); });
    $('#cmp-comparar').addEventListener('click', function () {
      E.comparando = !E.comparando;
      if (E.comparando && !E.selecao.length && E.atualId && grupo(atual()) !== 'referencia') E.selecao = [E.atualId];
      render();
    });
    $('#cmp-ref').addEventListener('click', function () { E.comparando = false; abrirReferencia(); });
    document.addEventListener('cf:mercado', function (e) { E.mercado = e.detail; render(); });
    document.addEventListener('cf:dados-restaurados', async function () {
      E.salvos = (await D.ler('cenarios')) || []; E.rascunhos = {};
      // F2: backup com cenários reais restaurado → sai do modo exemplo, para não misturar fictício e real na lista.
      if (E.salvos.length) { E.exemplos = null; E.comparando = false; E.selecao = []; }
      E.atualId = (E.salvos[0] || {}).id || E.atualId; render();
    });

    var res = await Promise.all([
      D.feriados().catch(function () { return null; }),
      D.referencia().catch(function () { return null; }),
      D.ler('cenarios').catch(function () { return null; }),
      D.mercado.ultimo().catch(function () { return null; }),
      D.lerLocal('cenarioAberto').catch(function () { return null; })
    ]);
    if (res[0]) E.feriados = { lista: res[0].feriados, cobertura: res[0].cobertura, fonte: res[0].fonte };
    if (res[1]) {
      E.referencia = res[1];
      // Formato antigo (um cenário só) continua aceito.
      if (!E.referencia.cenarios && E.referencia.cenario) E.referencia.cenarios = [{ cenario: E.referencia.cenario, esperado: E.referencia.esperado }];
      refs().forEach(function (r) { r.cenario.referencia = true; });
    }
    E.salvos = Array.isArray(res[2]) ? res[2] : [];
    if (!E.mercado) E.mercado = res[3];
    var aberto = res[4];
    if (aberto && (achar(aberto))) E.atualId = aberto;
    else if (E.salvos.length) E.atualId = E.salvos[0].id;
    if (!E.salvos.length) { await carregarExemplo(); return; }
    render();
  }
  window.Comparador = { _estado: E, calcular: calcular };
  iniciar();
})();
