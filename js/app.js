/*
 * Controle Financeiro — interface geral (navegação, mercado, rodapé, backup). Só lê window.Dados e mostra.
 * O comparador de renda fixa fica em js/comparador.js (F1).
 * F2: tela de desbloqueio, senha do site, travamento automático, atividade e backup protegido.
 */
(function () {
  'use strict';
  var D = window.Dados;
  var $ = function (s) { return document.querySelector(s); };

  var ROTAS = [
    { id: 'comparar', nome: 'Comparar', icone: [['path', { d: 'M4 20V10M10 20V4M16 20v-7M22 20H2' }]] },
    { id: 'carteira', nome: 'Carteira & IR', icone: [['rect', { x: 3, y: 6, width: 18, height: 14, rx: 2 }], ['path', { d: 'M8 6V4h8v2M3 12h18' }]] },
    { id: 'rendimentos', nome: 'Rendimentos', icone: [['path', { d: 'M12 2v20M17 6.5c0-1.9-2.2-3-5-3s-5 1.3-5 3.3 2.2 3 5 3.7 5 1.7 5 3.7-2.2 3.3-5 3.3-5-1.1-5-3' }]] },
    { id: 'mercado', nome: 'Mercado', icone: [['path', { d: 'M3 17l6-6 4 4 8-8' }], ['path', { d: 'M15 7h6v6' }]] }
  ];

  /* ---------- formatação pt-BR ---------- */
  var fmtPct = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function dataBR(iso) { if (!iso) return '—'; var p = String(iso).slice(0, 10).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function dataHoraBR(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  function el(tag, attrs, texto) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (texto != null) e.textContent = texto;
    return e;
  }

  /* Ícone montado elemento por elemento (sem innerHTML: a produção exige Trusted Types). */
  var SVG = 'http://www.w3.org/2000/svg';
  function svgIcone(partes) {
    var s = document.createElementNS(SVG, 'svg');
    [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]
      .forEach(function (a) { s.setAttribute(a[0], a[1]); });
    partes.forEach(function (p) { var e = document.createElementNS(SVG, p[0]); Object.keys(p[1]).forEach(function (k) { e.setAttribute(k, String(p[1][k])); }); s.appendChild(e); });
    return s;
  }

  /* ---------- navegação ---------- */
  function montarAbas() {
    document.querySelectorAll('nav.abas').forEach(function (nav) {
      ROTAS.forEach(function (r) {
        var a = el('a', { href: '#' + r.id, 'data-rota': r.id });
        a.appendChild(svgIcone(r.icone));
        a.appendChild(el('span', null, r.nome));
        nav.appendChild(a);
      });
    });
  }
  function irPara() {
    var alvo = (location.hash || '').replace('#', '');
    if (!ROTAS.some(function (r) { return r.id === alvo; })) alvo = 'comparar';
    document.querySelectorAll('section.modulo').forEach(function (s) { s.hidden = s.getAttribute('data-rota') !== alvo; });
    document.querySelectorAll('nav.abas a').forEach(function (a) {
      if (a.getAttribute('data-rota') === alvo) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    try { localStorage.setItem('cf1:ultimaAba', alvo); } catch (e) {}
  }

  /* ---------- mercado ---------- */
  var mercadoAtual = null;

  function preencherTabelas() {
    document.querySelectorAll('[data-tabela-mercado]').forEach(function (tb) {
      tb.textContent = '';
      tb.getAttribute('data-tabela-mercado').split(',').forEach(function (id) {
        var s = mercadoAtual && mercadoAtual.series[id];
        var tr = el('tr');
        var nome = s ? s.nome : (D.mercado.SERIES.concat(D.mercado.FOCUS).filter(function (x) { return x.id === id; })[0] || { nome: id }).nome;
        var td1 = el('td', null, nome);
        if (s && s.projecao) td1.appendChild(el('span', { class: 'proj' }, 'projeção'));
        tr.appendChild(td1);
        if (s) {
          tr.appendChild(el('td', { class: 'v num' }, fmtPct.format(s.valor) + ' ' + s.unidade));
          tr.appendChild(el('td', { class: 'num' }, s.projecao ? 'pesquisa de ' + dataBR(s.data) : dataBR(s.data)));
          tr.appendChild(el('td', null, s.fonte));
        } else {
          tr.appendChild(el('td', { class: 'v ausente' }, '⚠ falta ' + nome));
          tr.appendChild(el('td', null, '—'));
          tr.appendChild(el('td', null, '—'));
        }
        tb.appendChild(tr);
      });
    });
  }

  function aviso(texto) { var a = $('#aviso-mercado'); a.textContent = texto || ''; a.hidden = !texto; }

  function desatualizado(m) { return m && m.coletadoEm && D.diasUteisDesde(m.coletadoEm) > 1; }

  function rodape() {
    var r = $('#rodape'); r.textContent = '';
    var m = mercadoAtual;
    var t = 'Dados de mercado: ';
    if (m && m.coletadoEm) {
      t += 'BCB (SGS 432, 1178, 4389, 433, 226 e Focus), coletado em ' + dataHoraBR(m.coletadoEm) + ' · ' + m.origem;
    } else t += 'ainda não carregados';
    var s1 = el('span', null, t);
    if (desatualizado(m)) { s1.appendChild(document.createTextNode(' · ')); s1.appendChild(el('span', { class: 'selo' }, 'desatualizado')); }
    r.appendChild(s1);
    r.appendChild(el('span', null, 'Regras tributárias verificadas em ' + dataBR(D.REGRAS_VERIFICADAS)));
    r.appendChild(el('span', null, 'Motor renda fixa v' + (window.MotorRF ? window.MotorRF.versao : '—') + ' · feriados ANBIMA'));
    if (window.MotorCarteira) r.appendChild(el('span', null, 'Motor carteira v' + window.MotorCarteira.VERSAO + ' · regras de renda variável de ' + dataBR(window.MotorCarteira.versaoRegras)));
    r.appendChild(el('span', null, 'Site v' + D.VERSAO_SITE + ' · ' + (D.AMBIENTE === 'producao' ? 'Produção' : 'Homologação')));
    r.appendChild(el('span', null, 'Análise, não recomendação de investimento.'));
  }

  async function atualizar() {
    var b = $('#btn-atualizar'); b.disabled = true; b.querySelector('span').textContent = 'Atualizando…';
    try {
      var m = await D.mercado.atualizar();
      if (Object.keys(m.series).length) { mercadoAtual = m; document.dispatchEvent(new CustomEvent('cf:mercado', { detail: m })); }
      var avisos = (m.avisos || []).slice();
      if (D.AMBIENTE === 'homologacao' && m.coletadoEm) avisos.unshift('Homologação: o artifact não chama APIs externas; valores do snapshot gravado por Claude em ' + dataHoraBR(m.coletadoEm) + '.');
      aviso(avisos.join(' · '));
    } catch (e) {
      aviso('Não consegui atualizar os dados de mercado (' + e.message + '). Os valores anteriores continuam na tela, com a data em que foram coletados.');
    }
    b.disabled = false; b.querySelector('span').textContent = 'Atualizar';
    preencherTabelas(); rodape();
  }

  /* ---------- aviso de segurança ---------- */
  var avisosSeg = [];
  function avisoSeg(t) {
    if (t && avisosSeg.indexOf(t) < 0) avisosSeg.push(t);
    var a = $('#aviso-seguranca'); a.textContent = avisosSeg.join(' · '); a.hidden = !avisosSeg.length;
  }

  /* ---------- painel de dados / backup ---------- */
  var pendente = null, anterior = null, senhaDoBackup = null;
  function msg(t) { $('#d-msg').textContent = t || ''; }

  var NOMES_REG = {
    'abertura': 'Site aberto', 'desbloqueio': 'Desbloqueado', 'senha-errada': 'Senha errada', 'travado': 'Travado',
    'leitura': 'Leitura de dados', 'gravacao': 'Gravação de dados', 'backup-exportado': 'Backup exportado',
    'backup-importado': 'Backup importado', 'cofre-criado': 'Senha do site criada', 'senha-trocada': 'Senha trocada',
    'cofre-removido': 'Senha do site removida', 'alerta': 'Alerta', 'registro-exportado': 'Registro exportado', 'pendente': 'Evento com o site travado'
  };
  var ATENCAO = ['senha-errada', 'alerta', 'cofre-removido'];

  async function mostrarCofre() {
    var st = await D.cofre.estado();
    $('#cofre-criar').hidden = st.ativo;
    $('#cofre-gerir').hidden = !st.ativo;
    $('#bk-cofre-nota').hidden = !st.ativo;
    $('#bk-protecao').hidden = st.ativo;
    if (!st.ativo) $('#bk-protecao').open = true;
    $('#btn-travar').hidden = !(st.ativo && st.aberto);
    $('#cofre-estado').textContent = st.ativo
      ? 'Ativa desde ' + dataHoraBR(st.criadoEm) + '. Os dados deste navegador estão cifrados; o site trava depois de ' + MIN_TRAVA + ' minutos parado.'
      : (D.cofre.disponivel() ? 'Sem senha: os dados deste navegador estão sem cifra. Recomendado criar uma senha antes de lançar dados reais.' : 'Este navegador não oferece criptografia nesta página.');
  }

  async function mostrarRegistro() {
    var lista = $('#reg-lista'); lista.textContent = '';
    var r;
    try { r = await D.registro.ler(); } catch (e) { $('#reg-resumo').textContent = 'Registro indisponível (' + e.message + ').'; return; }
    var v = r.verificacao;
    $('#reg-resumo').textContent = r.itens.length + ' evento(s) neste navegador. Integridade do encadeamento: ' +
      (v.ok === true ? 'confere' : v.ok === false ? 'NÃO confere (' + v.problema + ')' : 'não verificável neste navegador') + '. ' +
      (r.autenticado ? 'Com a senha do site ativa, o registro é cifrado e autenticado.' : 'Sem a senha do site, o encadeamento só detecta erro acidental; adulteração deliberada só é detectada com a senha ativa.') +
      ' Mostrando os 40 mais recentes.';
    r.itens.slice(-40).reverse().forEach(function (e) {
      var li = el('li', { class: ATENCAO.indexOf(e.tipo) >= 0 ? 'atencao' : '' });
      li.appendChild(el('span', { class: 'quando' }, dataHoraBR(e.em)));
      li.appendChild(el('span', { class: 'tipo' }, NOMES_REG[e.tipo] || e.tipo));
      if (e.detalhe) li.appendChild(el('span', { class: 'det' }, e.detalhe));
      lista.appendChild(li);
    });
  }

  /* Área separada: o que não pôde ser aberto ou foi descartado. Baixar cópia (protegida pela senha do site) ou apagar. */
  async function mostrarQuarentena() {
    var box = $('#q-box'), lista;
    try { lista = await D.quarentena.resumo(); } catch (e) { box.hidden = false; $('#q-resumo').textContent = 'A área separada não pôde ser lida (' + e.message + ').'; return; }
    box.hidden = !lista.length;
    if (!lista.length) return;
    $('#q-resumo').textContent = lista.length + ' item(ns) guardado(s) à parte. Mais recente: ' + dataHoraBR(lista[lista.length - 1].em) + ' — ' + lista[lista.length - 1].motivo + '.';
  }
  async function baixarQuarentena() {
    try {
      var b = await D.quarentena.exportar();
      var nome = 'controle-financeiro-area-separada-' + new Date().toISOString().slice(0, 10) + '.json';
      await D.salvarArquivo(nome, JSON.stringify(b, null, 2));
      var st = await D.cofre.estado();
      msg('Cópia da área separada gerada: ' + nome + '.' + (st.ativo ? ' Ela está protegida com a senha do site.' : ' Atenção: ela saiu SEM proteção; quem abrir vê o conteúdo. Crie a senha do site para que as próximas cópias saiam protegidas.') +
        ' Guarde este arquivo em lugar seguro: o site ainda não reimporta a área separada.');
    } catch (e) { msg('Não gerei a cópia (' + e.message + ').'); }
  }
  async function apagarQuarentena() {
    if ($('#q-conf').value.trim() !== 'APAGAR') { msg('Para apagar a área separada, digite APAGAR no campo.'); return; }
    try { var n = await D.quarentena.apagar(); $('#q-conf').value = ''; await mostrarQuarentena(); msg(n + ' item(ns) apagado(s) da área separada.'); }
    catch (e) { msg('Não apaguei (' + e.message + ').'); }
  }

  async function abrirDados() {
    $('#painel-dados').hidden = false;
    $('#d-amb').textContent = D.AMBIENTE === 'producao' ? 'Produção (GitHub Pages)' : 'Homologação (artifact)';
    $('#d-onde').textContent = D.armazenamento().nome;
    var ult = await D.backup.ultimo();
    $('#d-backup').textContent = ult ? dataHoraBR(ult) + ' (' + D.diasUteisDesde(ult) + ' dia(s) útil(eis))' : 'nunca';
    $('#d-explica').textContent = D.AMBIENTE === 'producao'
      ? 'Seus dados ficam só neste navegador. Limpar os dados do navegador apaga tudo: exporte um backup depois de cada lançamento importante e guarde o arquivo fora do computador.'
      : 'Homologação usa apenas dados de teste. Seus dados reais ficam só na produção.';
    await mostrarCofre();
    await mostrarRegistro();
    await mostrarQuarentena();
    $('#fechar-dados').focus();
  }
  var CAMPOS_SENHA = ['#bk-senha', '#bk-senha2', '#bk-senha-imp', '#cofre-nova', '#cofre-nova2', '#cofre-atual', '#cofre-troca', '#cofre-troca2', '#cofre-rem'];
  function limparSenhas() { CAMPOS_SENHA.forEach(function (s) { $(s).value = ''; }); }
  function fecharDados() {
    $('#painel-dados').hidden = true; $('#confirma').hidden = true; $('#pede-senha').hidden = true;
    cifradoPendente = null; senhaDoBackup = null; limparSenhas(); msg(''); $('#btn-dados').focus();
  }

  /* ---------- senha do site (cofre) ---------- */
  async function criarCofre() {
    var s1 = $('#cofre-nova').value, s2 = $('#cofre-nova2').value;
    if (s1.length < 12) { msg('A senha precisa ter pelo menos 12 caracteres (uma frase de 4 ou 5 palavras é o ideal).'); $('#cofre-nova').focus(); return; }
    if (s1 !== s2) { msg('As duas senhas não são iguais.'); $('#cofre-nova2').focus(); return; }
    var b = $('#btn-cofre-criar'); b.disabled = true; msg('Cifrando os dados deste navegador…');
    try { await D.cofre.criar(s1); limparSenhas(); await abrirDados(); msg('Senha criada. Os dados deste navegador estão cifrados.'); }
    catch (e) { msg('Não criei a senha (' + e.message + ').'); }
    b.disabled = false;
  }
  async function trocarSenha() {
    var a = $('#cofre-atual').value, n1 = $('#cofre-troca').value, n2 = $('#cofre-troca2').value;
    if (n1.length < 12) { msg('A nova senha precisa ter pelo menos 12 caracteres.'); return; }
    if (n1 !== n2) { msg('As duas senhas novas não são iguais.'); return; }
    var b = $('#btn-cofre-trocar'); b.disabled = true; msg('Trocando a senha…');
    try { await D.cofre.trocarSenha(a, n1); limparSenhas(); await abrirDados(); msg('Senha trocada. Backups antigos continuam abrindo com a senha antiga.'); }
    catch (e) { msg('Não troquei a senha (' + e.message + ').'); }
    b.disabled = false;
  }
  async function removerSenha() {
    var b = $('#btn-cofre-remover'); b.disabled = true; msg('Removendo a senha…');
    try { await D.cofre.remover($('#cofre-rem').value); limparSenhas(); await abrirDados(); msg('Senha removida. Os dados deste navegador estão sem cifra.'); }
    catch (e) { msg('Não removi a senha (' + e.message + ').'); }
    b.disabled = false;
  }

  /* Tela de desbloqueio. Resolve quando a senha certa é digitada. */
  var estadoInicial = null;
  function pedirSenha() {
    return new Promise(function (ok) {
      document.body.classList.add('travado');
      var tela = $('#cofre-tela'); tela.hidden = false; $('#cofre-senha').focus();
      if (estadoInicial && estadoInicial.comprometido) {
        $('#cofre-msg').textContent = estadoInicial.comprometido;
        $('#cofre-senha').disabled = true; $('#cofre-entrar').disabled = true;
      } else if (estadoInicial && estadoInicial.planoCriacao) {
        $('#cofre-msg').textContent = 'Uma criação de senha ficou pela metade. Digite a senha que você acabou de criar para concluí-la. Se ela não abrir, os dados podem ter sido alterados por fora: apague os dados deste navegador e importe um backup.';
      } else if (estadoInicial && estadoInicial.motivoTrava) {
        $('#cofre-msg').textContent = 'Travado: ' + estadoInicial.motivoTrava + '.';
      }
      $('#cofre-form').addEventListener('submit', async function enviar(ev) {
        ev.preventDefault();
        var b = $('#cofre-entrar'); b.disabled = true; $('#cofre-msg').textContent = 'Conferindo…';
        try {
          var r = await D.cofre.desbloquear($('#cofre-senha').value);
          $('#cofre-senha').value = ''; tela.hidden = true; document.body.classList.remove('travado');
          $('#cofre-form').removeEventListener('submit', enviar);
          (r.avisos || []).forEach(function (a) { avisoSeg('Alerta de segurança: ' + a + '. Detalhes em Dados e backup → Atividade.'); });
          if (r.tentativasErradas.length) {
            avisoSeg('Atenção: ' + r.tentativasErradas.length + ' tentativa(s) de senha errada com o site travado, desde o seu último acesso (' +
              r.tentativasErradas.map(dataHoraBR).join(', ') + '). Detalhes em Dados e backup → Atividade.');
          }
          ok();
        } catch (e) {
          if (e.codigo === 'troca-concluida') {
            $('#cofre-senha').value = '';
            $('#cofre-msg').textContent = 'A troca de senha que estava pela metade foi concluída agora. Digite a senha NOVA para abrir.';
          } else {
            var st2 = await D.cofre.estado();
            if (st2.comprometido) { $('#cofre-msg').textContent = st2.comprometido; $('#cofre-senha').disabled = true; b.disabled = true; return; }
            $('#cofre-msg').textContent = e.message === 'senha incorreta' ? 'Senha incorreta. A tentativa foi registrada.' : 'Não abri: ' + e.message + '.';
          }
          $('#cofre-senha').select();
        }
        b.disabled = false;
      });
      $('#cofre-apagar').addEventListener('click', function () {
        if ($('#cofre-apagar-conf').value.trim() !== 'APAGAR') { $('#cofre-msg').textContent = 'Para apagar, digite APAGAR no campo.'; return; }
        D.cofre.apagarTudo();
      });
    });
  }

  /* Trava sozinho depois de MIN_TRAVA minutos sem uso. */
  var MIN_TRAVA = 15, ultimoUso = Date.now(), ultimoAvisoUso = 0, canalUso = null;
  function vigiarInatividade() {
    try { canalUso = new BroadcastChannel('cf1-uso'); canalUso.onmessage = function () { ultimoUso = Date.now(); limparAvisoTrava(); }; } catch (e) {}
    ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'].forEach(function (t) {
      document.addEventListener(t, function () {
        ultimoUso = Date.now(); limparAvisoTrava();
        // O uso numa aba conta para todas (o travamento automático é do site, não da aba).
        if (canalUso && ultimoUso - ultimoAvisoUso > 20000) { ultimoAvisoUso = ultimoUso; try { canalUso.postMessage(1); } catch (e) {} }
      }, { passive: true });
    });
    setInterval(async function () {
      var parado = Date.now() - ultimoUso;
      if (parado < (MIN_TRAVA - 1) * 60000) return;
      var st = await D.cofre.estado();
      if (!(st.ativo && st.aberto)) return;
      if (parado >= MIN_TRAVA * 60000) { D.cofre.travar('automático, ' + MIN_TRAVA + ' minutos sem uso'); return; }
      var a = $('#aviso-trava');
      if (a.hidden) { a.textContent = 'O site vai travar em 1 minuto por falta de uso. Salve o que estiver editando ou mexa o mouse para continuar.'; a.hidden = false; }
    }, 15000);
  }
  function limparAvisoTrava() { var a = $('#aviso-trava'); if (a && !a.hidden) a.hidden = true; }

  /* ---------- backup ---------- */
  async function exportar() {
    var st = await D.cofre.estado();
    var senha = st.ativo ? '' : $('#bk-senha').value, senha2 = st.ativo ? '' : $('#bk-senha2').value;
    if (senha || senha2) {
      if (senha !== senha2) { msg('As duas senhas não são iguais. O backup não foi gerado.'); $('#bk-senha2').focus(); return; }
      try { D.cofre.validarSenha(senha); } catch (e) { msg('Senha fraca: ' + e.message + '. O backup não foi gerado.'); $('#bk-senha').focus(); return; }
      if (!D.backup.criptoDisponivel()) { msg('Este navegador não oferece criptografia nesta página. O backup não foi gerado.'); return; }
    }
    var btn = $('#btn-exportar'); btn.disabled = true;
    try {
      var protegido = st.ativo || !!senha;
      if (protegido) msg('Cifrando o backup…');
      var b = await D.backup.exportar();
      var omitidos = b.omitidos || [];   // antes de cifrar (a cifra gera outro objeto)
      if (st.ativo) b = await D.backup.cifrarComCofre(b);
      else if (senha) b = await D.backup.cifrar(b, senha);
      var nome = 'controle-financeiro-backup-' + b.exportadoEm.slice(0, 10) + (protegido ? '-com-senha' : '') + (omitidos.length ? '-incompleto' : '') + '.json';
      await D.salvarArquivo(nome, JSON.stringify(b, null, 2));
      limparSenhas(); $('#bk-protecao').open = false;
      try { document.dispatchEvent(new CustomEvent('cf:backup-exportado')); } catch (e) {}
      await abrirDados();
      msg('Backup gerado: ' + nome + (st.ativo ? ' (protegido com a senha do site).' : senha ? ' (protegido por senha — guarde a senha em lugar seguro).' :
        '. Atenção: este arquivo saiu SEM proteção; quem abrir vê seus dados. Para proteger, crie a senha do site ou preencha "Proteger o backup com senha".') +
        (omitidos.length ? ' Atenção: o backup NÃO inclui ' + omitidos.join(', ') + ', que está ilegível neste navegador.' : ''));
    } catch (e) { msg('O backup não foi salvo (' + (e.message || e.code || e) + ').'); }
    btn.disabled = false;
  }

  async function exportarRegistro() {
    try {
      var r = await D.registro.exportar();
      var nome = 'controle-financeiro-registro-' + r.exportadoEm.slice(0, 10) + '.json';
      await D.salvarArquivo(nome, JSON.stringify(r, null, 2));
      msg('Registro exportado: ' + nome + '. Ele não contém valores da carteira, só os eventos.');
    } catch (e) { msg('O registro não foi exportado (' + e.message + ').'); }
  }

  function mostrarConfirmacao(obj) {
    var v = D.backup.validar(obj);
    if (!v.ok) { msg('Não importei: ' + v.erros.join('; ') + '.'); return; }
    pendente = obj;
    var partes = Object.keys(v.resumo).map(function (k) { return k + ': ' + v.resumo[k]; }).join(' · ');
    $('#confirma-txt').textContent = 'Backup de ' + dataHoraBR(v.exportadoEm) + ' (' + v.ambiente + '). Conteúdo — ' + partes +
      '. Importar substitui todos os dados atuais deste ambiente.' +
      (v.marcasRemovidas ? ' Atenção: o arquivo trazia ' + v.marcasRemovidas + ' marca(s) que só o próprio site pode dar (exemplo, referência ou mercado fixo); elas foram removidas.' : '');
    $('#confirma').hidden = false; msg('');
  }

  var cifradoPendente = null;
  function lerArquivo(ev) {
    var f = ev.target.files && ev.target.files[0]; if (!f) return;
    // Arquivo grande demais não é backup deste site (evita travar a página com um arquivo malicioso).
    if (f.size > 5 * 1024 * 1024) { msg('Não importei: o arquivo tem mais de 5 MB e não parece um backup deste site.'); ev.target.value = ''; return; }
    var rd = new FileReader();
    rd.onload = function () {
      var obj; try { obj = JSON.parse(rd.result); } catch (e) { msg('O arquivo não é um JSON válido.'); return; }
      $('#confirma').hidden = true; pendente = null; senhaDoBackup = null;
      if (D.backup.estaCifrado(obj)) {
        var v = D.backup.validarCifrado(obj);
        if (!v.ok) { msg('Não importei: ' + v.erros.join('; ') + '.'); return; }
        cifradoPendente = obj;
        $('#pede-senha-txt').textContent = 'Backup de ' + dataHoraBR(v.exportadoEm) + ' (' + v.ambiente + ') protegido por senha. Digite a senha para ver o conteúdo antes de importar.';
        $('#pede-senha').hidden = false; msg(''); $('#bk-senha-imp').focus();
        return;
      }
      mostrarConfirmacao(obj);
    };
    rd.readAsText(f); ev.target.value = '';
  }

  async function decifrar() {
    if (!cifradoPendente) return;
    var btn = $('#btn-decifrar'); btn.disabled = true; msg('Abrindo o backup…');
    try {
      var senha = $('#bk-senha-imp').value;
      var aberto = await D.backup.decifrar(cifradoPendente, senha);
      cifradoPendente = null; $('#pede-senha').hidden = true; limparSenhas();
      senhaDoBackup = senha; // só até confirmar ou cancelar: protege este navegador com a mesma senha
      mostrarConfirmacao(aberto);
    } catch (e) { msg('Não abri o backup: ' + e.message + '.'); $('#bk-senha-imp').select(); }
    btn.disabled = false;
  }

  var restaurando = false;
  async function restaurar(ev) {
    if (ev && ev.detail > 1) return;          // segundo clique de um duplo clique
    if (!pendente || restaurando) return;
    restaurando = true; $('#btn-restaurar').disabled = true;
    var senhaFraca = false, criouSenha = false;
    try {
      var st = await D.cofre.estado();
      // Backup protegido restaurado num navegador sem senha: o navegador passa a ter a mesma senha do backup,
      // se ela atender às regras atuais; senão importa e pede para criar uma senha forte.
      if (senhaDoBackup && !st.ativo && D.cofre.disponivel()) {
        try { D.cofre.validarSenha(senhaDoBackup); } catch (e) { senhaFraca = true; }
        if (!senhaFraca) { await D.cofre.criar(senhaDoBackup); criouSenha = true; }
      }
      senhaDoBackup = null;
      anterior = await D.backup.restaurar(pendente);
      pendente = null; $('#confirma').hidden = true;
      setTimeout(function () { $('#desfazer-box').hidden = false; }, 1200);   // longe de um duplo clique
      await mostrarCofre(); await mostrarRegistro();
      msg('Dados substituídos pelo backup' + (criouSenha ? ' e este navegador passou a usar a senha do backup' : '') + '. Você pode desfazer enquanto esta página estiver aberta.' +
        (senhaFraca ? ' A senha do backup não atende às regras atuais, então os dados ficaram SEM senha neste navegador: crie uma senha agora em "Senha do site".' : ''));
    } catch (e) {
      msg(/pela metade/.test(e.message) ? 'A importação ficou pela metade e será concluída quando o site abrir de novo.' : 'Não importei (' + e.message + '). Seus dados atuais não foram substituídos.');
    }
    restaurando = false; $('#btn-restaurar').disabled = false;
  }
  async function desfazer(ev) {
    if (ev && ev.detail > 1) return;
    if (!anterior) return;
    await D.backup.restaurar(anterior); anterior = null; $('#desfazer-box').hidden = true;
    msg('Importação desfeita: dados anteriores restaurados.');
  }

  /* ---------- início ---------- */
  async function iniciar() {
    // Produção: o site não abre dentro de outra página (proteção contra clique disfarçado; a política de
    // segurança por <meta> não cobre isso e o GitHub Pages não permite configurar cabeçalhos).
    if (D.AMBIENTE === 'producao' && window.top !== window.self) {
      document.body.textContent = 'Por segurança, o Controle Financeiro não abre dentro de outra página. Abra o endereço diretamente no navegador.';
      return;
    }
    var chip = $('#chip-amb');
    chip.textContent = D.AMBIENTE === 'producao' ? 'Produção' : 'Homologação';
    chip.className = 'chip ' + D.AMBIENTE;

    // Dado ilegível: o site não grava por cima; oferece descartar (com cópia na quarentena) só por pedido explícito.
    document.addEventListener('cf:ilegivel', function (e) {
      var k = e.detail, box = $('#ilegivel-box');
      if (!box.hidden) return;
      box.textContent = '';
      box.appendChild(el('span', null, 'Os dados de "' + k + '" guardados neste navegador não puderam ser lidos e não serão sobrescritos. Se você tem um backup, importe-o. Ou descarte o conteúdo ilegível (uma cópia fica na área separada, em Dados e backup, de onde você pode baixá-la) para voltar a salvar. '));
      var bt = el('button', { class: 'btn mini', type: 'button' }, 'Descartar os ilegíveis');
      bt.addEventListener('click', async function () {
        try { await D.descartarIlegivel(k); box.hidden = true; location.reload(); }
        catch (er) { box.appendChild(el('span', null, ' Não consegui descartar (' + er.message + ').')); }
      });
      box.appendChild(bt); box.hidden = false;
    });
    // Alertas da Porta (dado alterado por fora, por exemplo) aparecem no topo assim que acontecem.
    document.addEventListener('cf:alerta', function (e) { avisoSeg('Alerta de segurança: ' + e.detail + '. Detalhes em Dados e backup → Atividade.'); });
    // Porta trancada: nada de dado na tela antes da senha.
    var st = await D.cofre.estado(); estadoInicial = st;
    if (st.bloqueio === 'arquivo-local') {
      document.body.textContent = 'O Controle Financeiro não abre como arquivo do computador: aqui qualquer outro arquivo HTML aberto no navegador poderia ler seus dados. Use o endereço oficial do site.';
      return;
    }
    if (st.comprometido || (st.ativo && !st.aberto)) await pedirSenha();
    st.avisos.forEach(function (a) { avisoSeg('Alerta de segurança: ' + a + '. Detalhes em Dados e backup → Atividade.'); });
    vigiarInatividade();

    montarAbas();
    if (!location.hash) { try { var u = localStorage.getItem('cf1:ultimaAba'); if (u) location.hash = u; } catch (e) {} }
    irPara();
    window.addEventListener('hashchange', irPara);
    $('#btn-atualizar').addEventListener('click', atualizar);
    $('#btn-travar').addEventListener('click', function () { D.cofre.travar('pelo botão'); });
    $('#btn-dados').addEventListener('click', abrirDados);
    document.addEventListener('cf:abrir-dados', abrirDados);
    $('#fechar-dados').addEventListener('click', fecharDados);
    $('#painel-dados').addEventListener('click', function (e) { if (e.target.id === 'painel-dados') fecharDados(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#painel-dados').hidden) fecharDados(); });
    $('#btn-exportar').addEventListener('click', exportar);
    $('#arq-importar').addEventListener('change', lerArquivo);
    $('#btn-restaurar').addEventListener('click', restaurar);
    $('#btn-cancelar').addEventListener('click', function () { pendente = null; senhaDoBackup = null; $('#confirma').hidden = true; });
    $('#btn-desfazer').addEventListener('click', desfazer);
    $('#btn-decifrar').addEventListener('click', decifrar);
    $('#bk-senha-imp').addEventListener('keydown', function (e) { if (e.key === 'Enter') decifrar(); });
    $('#btn-cancelar-senha').addEventListener('click', function () { cifradoPendente = null; $('#pede-senha').hidden = true; limparSenhas(); });
    $('#btn-cofre-criar').addEventListener('click', criarCofre);
    $('#btn-cofre-trocar').addEventListener('click', trocarSenha);
    $('#btn-cofre-remover').addEventListener('click', removerSenha);
    $('#btn-reg-exportar').addEventListener('click', exportarRegistro);
    $('#btn-q-baixar').addEventListener('click', baixarQuarentena);
    $('#btn-q-apagar').addEventListener('click', apagarQuarentena);
    if (D.semTravaEntreAbas()) avisoSeg('Este navegador não oferece trava entre abas: mantenha o site aberto em uma aba só para não perder gravações.');
    $('#btn-travar').hidden = !(st.ativo);

    // Mostra o último valor guardado (com a data); só busca de novo quando o usuário clica em Atualizar.
    mercadoAtual = await D.mercado.ultimo();
    preencherTabelas(); rodape();
    if (D.AMBIENTE === 'homologacao') {
      // Na homologação, ler o snapshot não consome nada nem chama API: relê sempre na abertura.
      await atualizar(); return;
    }
    if (!mercadoAtual) aviso('Dados de mercado ainda não carregados. Clique em Atualizar.');
    else if (desatualizado(mercadoAtual)) aviso('Dados de mercado com mais de 1 dia útil. Clique em Atualizar.');
    preencherTabelas(); rodape();
  }
  iniciar();
})();
