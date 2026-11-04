/*
 * Controle Financeiro — Carteira (F3): saldo inicial, compras e vendas, eventos da empresa, posição com
 * cotação digitada, pendências e aviso de backup (Passo A); opções, cobertura, caixa das puts e campanhas (Passo B). Lê e grava só por window.Dados; calcula só com window.MotorCarteira.
 * Nenhuma fórmula financeira aqui: a tela converte texto em número, monta os lançamentos e mostra o resultado do motor.
 */
(function () {
  'use strict';
  var D = window.Dados, M = window.MotorCarteira;
  var $ = function (s) { return document.querySelector(s); };
  var raiz = $('#carteira');
  if (!raiz || !M || !D) return;
  var URL_SICALC = 'https://sicalc.receita.fazenda.gov.br/sicalc/principal';   // decisão 10; o build confere o endereço

  /* ================= formatação pt-BR ================= */
  var BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  function nf(v, dec) { return typeof v === 'number' && isFinite(v) ? v.toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : '—'; }
  function reais(v) { return typeof v === 'number' && isFinite(v) ? BRL.format(v) : '—'; }
  function reaisSinal(v) { return !(typeof v === 'number' && isFinite(v)) ? '—' : (v < 0 ? '− ' + BRL.format(-v) : (v > 0 ? '+ ' : '') + BRL.format(v)); }
  function qtdBR(v) { return !(typeof v === 'number' && isFinite(v)) ? '—' : v.toLocaleString('pt-BR', { maximumFractionDigits: 6 }); }
  function pm(v) { return !(typeof v === 'number' && isFinite(v)) ? '—' : 'R$ ' + nf(v, v !== 0 && Math.abs(v) < 1 ? 4 : 2); }
  function pct(v) { return !(typeof v === 'number' && isFinite(v)) ? '—' : (v < 0 ? '− ' : v > 0 ? '+ ' : '') + nf(Math.abs(v * 100), 2) + '%'; }
  function dataBR(iso) { if (!iso) return '—'; var p = String(iso).slice(0, 10).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function mesBR(m) { var p = String(m).split('-'); return p[1] + '/' + p[0]; }
  function dataHoraBR(t) { return t ? dataBR(t) + ' ' + String(t).slice(11, 16) : '—'; }
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
  function numParaCampo(v) { return v == null ? '' : String(v).replace('.', ','); }
  function novoId() {
    var b = new Uint8Array(6); window.crypto.getRandomValues(b);
    return 'l' + Date.now().toString(36) + Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  function agoraIso() { return new Date().toISOString(); }

  /* ================= estado ================= */
  var E = {
    carteira: null,        // { versao:1, lancamentos:[], classes:{}, cotacoes:{} }
    exemplo: null,         // carteira fictícia só na memória
    res: null,             // saída do motor
    form: null,            // { tipo, id? }
    feriados: [],          // data/feriados.json (vencimento sugerido das opções)
    ilegivel: false,
    desfazer: null
  };
  function atual() { return E.exemplo || E.carteira; }
  function vazia() { return { versao: 1, lancamentos: [], classes: {}, cotacoes: {}, opcoes: {}, irrf: {}, darfs: {} }; }
  function temProp(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function cadastroDe(c, t) { return c && temProp(c.opcoes, t) ? c.opcoes[t] : null; }
  function ehOpcao(t) { return M.classificar(t, null, null).classe === 'OPCAO'; }
  function dataRef() { return E.exemplo && E.exemplo.dataReferencia ? E.exemplo.dataReferencia : hojeIso(); }
  function opcoesMotor(c) { return { manual: c.classes || {}, cadastroOpcoes: c.opcoes || {}, hoje: dataRef(), estimarIrrf: true, irrfInformado: c.irrf || {} }; }

  function status(t) { $('#cart-status').textContent = t || ''; }

  var NOME_EVENTO = { SALDO: 'Saldo inicial', DESDOBRAMENTO: 'Desdobramento', GRUPAMENTO: 'Grupamento', BONIFICACAO: 'Bonificação',
    DIREITO_RECEBIDO: 'Direito de subscrição recebido', SUBSCRICAO: 'Subscrição exercida', EXPIRACAO: 'Direito expirado',
    INCORPORACAO: 'Incorporação / conversão', LEILAO_FRACAO: 'Leilão de fração', VENCIMENTO: 'Vencimento de opção', EXERCICIO: 'Exercício de opção' };
  var EVENTOS_TELA = ['DESDOBRAMENTO', 'GRUPAMENTO', 'BONIFICACAO', 'DIREITO_RECEBIDO', 'SUBSCRICAO', 'EXPIRACAO', 'INCORPORACAO', 'LEILAO_FRACAO'];
  function nomeTipo(l) { return l.tipo ? (NOME_EVENTO[l.tipo] || l.tipo) : (l.lado === 'C' ? 'Compra' : 'Venda') + (ehOpcao(l.ativo) ? ' de opção' : ''); }

  /* ================= cálculo ================= */
  function calcular() {
    var c = atual();
    E.res = c ? M.processar(c.lancamentos, opcoesMotor(c)) : null;
    E.painel = c ? M.painelIR(E.res.apuracao, { pagos: c.darfs || {}, hoje: dataRef(), feriados: E.feriados }) : null;
  }

  /* ================= desenho ================= */
  function desenhar() {
    var c = atual();
    var temDados = c && c.lancamentos.length > 0;
    $('#cart-vazio').hidden = !!temDados || E.ilegivel;
    $('#cart-corpo').hidden = !temDados;
    var banner = $('#cart-banner'); banner.textContent = '';
    banner.hidden = !E.exemplo;
    if (E.exemplo) {
      add(banner, el('strong', null, 'Exemplo — dados fictícios.'), ' Ativos inventados; nada aqui é gravado ou entra no backup. Para lançar os seus dados, saia do exemplo.');
      var sair = el('button', { class: 'btn mini', type: 'button' }, 'Sair do exemplo');
      sair.addEventListener('click', sairExemplo); banner.appendChild(sair);
    }
    ['#cart-novo-neg', '#cart-novo-opcao', '#cart-novo-saldo', '#cart-novo-evento'].forEach(function (s) { $(s).disabled = !!E.exemplo || E.ilegivel; });
    $('#cart-exemplo').hidden = !!E.exemplo;
    desenharBackup();
    try {
      calcular();
      if (!temDados) { desenharForm(); return; }
      desenharResumo(); desenharPendencias(); desenharAvisos(); desenharIR(); desenharPosicao(); desenharOpcoes(); desenharCampanhas(); desenharLancamentos(); desenharExtrato(); desenharRegras();
    } catch (e) {
      // Erro inesperado no cálculo ou no desenho: a lista de lançamentos continua na tela para corrigir ou excluir (7ª revisão, N1).
      E.res = { posicoes: {}, extrato: [], pendencias: [], avisos: [], opcoesAbertas: [], cobertura: {}, caixaPuts: { total: 0, semStrike: [] }, campanhas: [], apuracao: [] };
      E.painel = null;
      ['#cart-resumo', '#cart-pend', '#cart-ir', '#cart-posicao', '#cart-opcoes', '#cart-campanhas', '#cart-extrato', '#cart-regras'].forEach(function (s2) { $(s2).textContent = ''; });
      $('#cart-pend').appendChild(el('p', { class: 'aviso' }, 'Não consegui calcular a carteira (' + (e && e.message ? e.message : 'erro') + '). Os lançamentos estão abaixo: corrija ou exclua o que estiver estranho e mande um print para o Claude.'));
      try { desenharLancamentos(); } catch (e2) {}
    }
    desenharForm();
  }

  async function desenharBackup() {
    var box = $('#cart-backup');
    if (E.exemplo || !E.carteira) { box.hidden = true; return; }
    var ult = null; try { ult = await D.backup.ultimo(); } catch (e) {}
    var a = M.avisoBackup(ult, E.carteira.lancamentos, agoraIso());
    box.textContent = '';
    if (!a.mostrar) { box.hidden = true; return; }
    var t = a.nunca ? 'Você ainda não fez backup da carteira. ' :
      'Último backup há ' + a.dias + ' dia(s), com ' + a.depois + ' lançamento(s) feitos depois dele. ';
    add(box, el('span', null, t + 'Limpar os dados do navegador apaga tudo: exporte um backup e guarde o arquivo fora do computador.'));
    var b = el('button', { class: 'btn mini', type: 'button' }, 'Fazer backup');
    b.addEventListener('click', function () { document.dispatchEvent(new CustomEvent('cf:abrir-dados')); });
    box.appendChild(b); box.hidden = false;
  }

  function cartaoResumo(rotulo, valor, extra, cls) {
    var d = el('div', { class: 'cart-num' + (cls ? ' ' + cls : '') });
    add(d, el('span', { class: 'v-rotulo' }, rotulo), el('span', { class: 'cart-num-v num' }, valor));
    if (extra) d.appendChild(el('span', { class: 'cart-num-x' }, extra));
    return d;
  }
  function linhasPosicao() {
    var c = atual(), lista = [];
    Object.keys(E.res.posicoes).sort().forEach(function (a) {
      var p = E.res.posicoes[a];
      if ((p.qtd === 0 && !p.fracao) || p.classe === 'OPCAO') return;   // opções têm quadro próprio
      var cot = (c.cotacoes || {})[a] || null;
      lista.push({ p: p, cot: cot, nr: M.naoRealizado(p, cot) });
    });
    return lista;
  }
  function desenharResumo() {
    var box = $('#cart-resumo'); box.textContent = '';
    var lin = linhasPosicao(), custo = 0, mercado = 0, semCot = 0, semPm = 0, comCot = 0, custoComCot = 0, resultado = 0, comRes = 0;
    lin.forEach(function (x) {
      if (!(x.p.qtd > 0)) return;
      if (!x.p.pmDesconhecido) custo += x.p.qtd * x.p.pm; else semPm++;
      if (x.cot && x.cot.valor > 0) { mercado += x.p.qtd * x.cot.valor; comCot++; } else semCot++;
      if (x.nr) { resultado += x.nr.resultado; custoComCot += x.nr.custo; comRes++; }
    });
    var notaCot = [semCot ? semCot + ' sem cotação' : '', semPm ? semPm + ' sem preço médio' : ''].filter(Boolean).join(' · ');
    var np = E.res.pendencias.length, nopc = (E.res.opcoesAbertas || []).length;
    add(box,
      cartaoResumo('Custo da posição', reais(custo), lin.length + ' ativo(s)' + (semPm ? ' · ' + semPm + ' sem preço médio' : '') + (nopc ? ' · ' + nopc + ' opção(ões) à parte' : '')),
      cartaoResumo('Valor pela cotação', comCot ? reais(mercado) : '—', comCot + ' de ' + (comCot + semCot) + ' ativo(s) com cotação digitada'),
      cartaoResumo('Resultado não realizado', comRes ? reaisSinal(resultado) : '—', comRes ? pct(custoComCot ? resultado / custoComCot : null) + ' sobre o custo · ' + comRes + ' ativo(s)' + (notaCot ? ' (fora: ' + notaCot + ')' : '') : notaCot,
        comRes ? (resultado < 0 ? 'neg' : 'pos') : ''),
      cartaoResumo('Pendências', String(np), np ? 'resolva para os números fecharem' : 'nenhuma', np ? 'alerta' : 'ok'),
      cartaoDarf());
  }

  function cartaoDarf() {
    var P = E.painel;
    if (P.mesesSemValor) return cartaoResumo('DARF em aberto', '—', P.mesesSemValor + ' mês(es) sem valor: ver ' + mesBR(P.primeiroBloqueio), 'alerta');
    var parc = P.mesAtual ? reais(P.mesAtual.valor) + ' parcial de ' + mesBR(P.mesAtual.mes) : null;
    return cartaoResumo('DARF em aberto', reais(P.emAberto), parc || (P.emAberto ? 'meses encerrados' : 'nada a pagar'), P.emAberto ? 'alerta' : 'ok');
  }

  /* ---------- pendências ---------- */
  function desenharPendencias() {
    var box = $('#cart-pend'); box.textContent = '';
    var lista = E.res.pendencias;
    // Uma linha por pendência; classificação aparece uma vez por ativo.
    if (!lista.length) { box.appendChild(el('p', { class: 'muted' }, 'Nenhuma pendência: todos os lançamentos foram calculados.')); return; }
    var ul = el('ul', { class: 'pend-lista' });
    var maisPend = el('div');
    lista = limitar(lista, 'pend', maisPend, 'pendências', desenharPendencias);
    lista.forEach(function (p) {
      var li = el('li', { class: 'pend' + (p.fracao || p.info ? ' info' : '') });
      add(li, el('span', { class: 'pend-tipo' }, rotuloPend(p.tipo)), el('span', { class: 'pend-txt' }, p.texto));
      var acoes = el('span', { class: 'pend-acoes' });
      if (!E.exemplo) {
        if (p.tipo === 'CLASSIFICAR') acoes.appendChild(formClassificar(p.ativo));
        else if (p.tipo === 'FRACAO') { var bf = el('button', { class: 'btn mini', type: 'button' }, 'Lançar leilão'); bf.addEventListener('click', function () { abrirForm('EVENTO', null, { tipo: 'LEILAO_FRACAO', ativo: p.ativo }); }); acoes.appendChild(bf); }
        else if (p.tipo === 'OPCAO_CADASTRO') acoes.appendChild(botao('Cadastrar', function () { abrirForm('CADASTRO', null, { ativo: p.ativo }); }, 'Cadastrar a opção ' + p.ativo));
        else if (p.tipo === 'VENCIMENTO_PENDENTE') add(acoes, botao('Virou pó', function () { abrirForm('VENCIMENTO', null, { ativo: p.ativo, data: p.data }); }, 'Lançar vencimento sem exercício de ' + p.ativo),
          botao('Exercício', function () { abrirForm('EXERCICIO', null, { ativo: p.ativo, data: p.data }); }, 'Lançar exercício de ' + p.ativo));
        else if (p.id && acharLanc(p.id)) { var b = el('button', { class: 'btn mini', type: 'button' }, 'Corrigir'); b.addEventListener('click', function () { editar(p.id); }); acoes.appendChild(b); }
      }
      li.appendChild(acoes); ul.appendChild(li);
    });
    box.appendChild(ul); box.appendChild(maisPend);
  }
  /* Avisos do motor (não bloqueiam o cálculo): bonificação e Lei 15.270, incorporação, fora do cálculo, call descoberta,
     exercício com tipo divergente. Até a v0.10.0 não apareciam na tela. */
  function desenharAvisos() {
    var vistos = Object.create(null), lista = (E.res.avisos || []).filter(function (a) { if (vistos[a.texto]) return false; vistos[a.texto] = true; return true; });
    if (!lista.length) return;
    var box = $('#cart-pend'), ul = el('ul', { class: 'pend-lista avisos' }), mais = el('div');
    box.appendChild(el('p', { class: 'sub-cad' }, 'Avisos (não bloqueiam o cálculo)'));
    limitar(lista, 'avisos', mais, 'avisos', desenhar).forEach(function (a) {
      var li = el('li', { class: 'pend info' });
      add(li, el('span', { class: 'pend-tipo' }, 'Aviso'), el('span', { class: 'pend-txt' }, a.texto), el('span', { class: 'pend-acoes' }));
      ul.appendChild(li);
    });
    box.appendChild(ul); box.appendChild(mais);
  }
  function rotuloPend(t) {
    return { CLASSIFICAR: 'Classificar', VENDA_ACIMA: 'Venda acima da posição', CUSTOS: 'Custos', PM_DESCONHECIDO: 'Preço médio', BONIFICACAO_SEM_CUSTO: 'Bonificação',
      FRACAO: 'Fração', EVENTO_SEM_POSICAO: 'Evento', EVENTO: 'Evento', SALDO: 'Saldo inicial',
      EXERCICIO_ACIMA: 'Exercício', VENCIMENTO_PENDENTE: 'Vencimento', OPCAO_CADASTRO: 'Cadastro da opção' }[t] || t;
  }
  /* Tabelas longas: mostra as primeiras N linhas e um botão para mais (20.000 ativos travavam a aba; 7ª revisão, N2). */
  function limitar(lista, chave, box, rotuloItens, redesenhar) {
    var lim = (E.limites && E.limites[chave]) || 300;
    if (lista.length <= lim) return lista;
    var p = el('p', { class: 'nota-tab' }, 'Mostrando ' + lim + ' de ' + lista.length + ' ' + rotuloItens + '. ');
    var b = el('button', { class: 'btn mini', type: 'button' }, 'Mostrar mais ' + Math.min(300, lista.length - lim));
    b.addEventListener('click', function () { E.limites = E.limites || {}; E.limites[chave] = lim + 300; redesenhar(); });
    p.appendChild(b); box.appendChild(p);
    return lista.slice(0, lim);
  }
  function botao(texto, fn, rotulo, cls) {
    var b = el('button', { class: 'btn mini' + (cls ? ' ' + cls : ''), type: 'button', 'aria-label': rotulo || null }, texto);
    b.addEventListener('click', fn); return b;
  }
  function formClassificar(ativo) {
    var w = el('span', { class: 'linha-acao' });
    var id = 'cls-' + ativo;
    var lab = el('label', { class: 'sr', for: id }, 'Classe de ' + ativo);
    var sel = el('select', { id: id });
    sel.appendChild(el('option', { value: '' }, 'Escolha…'));
    M.CLASSES.filter(function (c) { return c !== 'OPCAO' && c !== 'DIREITO'; }).forEach(function (c) { sel.appendChild(el('option', { value: c }, M.NOME_CLASSE[c])); });
    var b = el('button', { class: 'btn mini prim', type: 'button' }, 'Salvar');
    b.addEventListener('click', async function () {
      if (!sel.value) { status('Escolha a classe de ' + ativo + '.'); sel.focus(); return; }
      var c = copiaCarteira(); c.classes[ativo] = sel.value;
      if (await gravar(c, ativo + ' classificado como ' + M.NOME_CLASSE[sel.value] + ' (classificação manual).')) desenhar();
    });
    add(w, lab, sel, b);
    return w;
  }

  /* ---------- imposto de renda por mês (F4): os números vêm do motor; a tela só mostra ---------- */
  function rotuloSituacao(x) {
    switch (x.situacao) {
      case 'INCOMPLETO': return { t: '⚠ Incompleto', c: 'ausente' };
      case 'DEPENDE': return { t: '⚠ Depende de ' + mesBR(x.dependeDe), c: 'ausente' };
      case 'SEM_IMPOSTO': return { t: x.emAndamento ? 'Sem imposto até agora' : 'Sem imposto', c: '' };
      case 'ACUMULA': return { t: 'Abaixo de R$ 10: soma ao próximo', c: '' };
      case 'VENCIDO': return { t: '⚠ Vencido em ' + dataBR(x.vencimento), c: 'ausente' };
      case 'PAGO': return { t: '✓ Pago em ' + dataBR(x.pago.pagoEm), c: 'ir-pago' };
      case 'PAGO_DIFERENTE': return { t: '⚠ Pago com diferença', c: 'ausente' };
      default: return { t: x.emAndamento ? 'Parcial: mês em andamento' : 'A pagar até ' + dataBR(x.vencimento), c: '' };
    }
  }
  function desenharIR() {
    var box = $('#cart-ir'); box.textContent = '';
    var P = E.painel;
    if (!P || !P.meses.length) { box.appendChild(el('p', { class: 'muted' }, 'Nenhuma venda, day trade ou opção encerrada ainda: não há imposto a apurar.')); return; }
    if (P.mesesSemValor) box.appendChild(el('p', { class: 'aviso' }, 'Há ' + P.mesesSemValor + ' mês(es) sem valor a pagar. ' + mesBR(P.primeiroBloqueio) + ' está incompleto: resolva as pendências dele. Os meses seguintes dependem dele, porque o prejuízo e o saldo de IRRF passam de um mês para o outro.'));
    var prej = el('p', { class: 'ir-prej' });
    add(prej, el('strong', null, 'Prejuízo a compensar' + (P.prejuizosConfiaveis ? ': ' : ' (até o mês incompleto ainda pode mudar): ')),
      'comum ' + reais(P.prejuizos.COMUM) + ' · day trade ' + reais(P.prejuizos.DAYTRADE) + ' · FII/Fiagro ' + reais(P.prejuizos.FII));
    box.appendChild(prej);
    var maisIR = el('div');
    var lista = limitar(P.meses, 'ir', maisIR, 'meses', desenharIR);
    var wrap = el('div', { class: 'tabela-wrap' }), t = el('table', { class: 'tab-ir' }), tr = el('tr');
    [['Mês'], ['Vendas de ações', 'a-dir'], ['Imposto', 'a-dir'], ['IRRF descontado', 'a-dir'], ['DARF', 'a-dir'], ['Situação'], ['', 'a-dir']]
      .forEach(function (h) { tr.appendChild(el('th', { scope: 'col', class: h[1] }, h[0])); });
    add(t, add(el('thead'), tr));
    var tb = el('tbody');
    lista.forEach(function (x) {
      var a = x.apuracao, r = el('tr', { class: E.mesIR === x.mes ? 'ir-aberto' : null });
      var semValor = x.darf == null, totalImp = 0, totalIr = 0;
      if (a) ['COMUM', 'DAYTRADE', 'FII'].forEach(function (c) { totalImp += a.categorias[c].imposto; totalIr += a.categorias[c].irrfDeduzido; });
      r.appendChild(add(el('td', { class: 'num' }), el('strong', null, mesBR(x.mes))));
      r.appendChild(el('td', { class: 'v num' }, a ? reais(a.vendasAcoes) : '—'));
      r.appendChild(el('td', { class: 'v num' }, a && !semValor ? reais(totalImp) : '—'));
      r.appendChild(el('td', { class: 'v num' }, a && !semValor ? reais(totalIr) : '—'));
      r.appendChild(el('td', { class: 'v num ' + (semValor ? 'ausente' : '') }, semValor ? '—' : reais(x.darf)));
      var s = rotuloSituacao(x);
      r.appendChild(el('td', { class: s.c }, s.t));
      r.appendChild(add(el('td', { class: 'acoes-lanc' }), botao(E.mesIR === x.mes ? 'Fechar' : 'Detalhes', function () { E.mesIR = E.mesIR === x.mes ? null : x.mes; E.irForm = null; desenharIR(); }, (E.mesIR === x.mes ? 'Fechar o mês ' : 'Ver o mês ') + mesBR(x.mes))));
      tb.appendChild(r);
    });
    t.appendChild(tb); wrap.appendChild(t); box.appendChild(wrap); box.appendChild(maisIR);
    var aberto = P.meses.filter(function (x) { return x.mes === E.mesIR; })[0];
    if (aberto) box.appendChild(detalheMes(aberto));
    box.appendChild(el('p', { class: 'nota-tab' }, 'Cálculo de apoio, não substitui contador. Regras verificadas em ' + dataBR(M.versaoRegras) + ' · motor v' + M.VERSAO + '.'));
  }
  function detalheMes(x) {
    var a = x.apuracao, d = el('div', { class: 'painel-cen ir-det', id: 'ir-det' });
    d.appendChild(el('h3', null, 'Imposto de ' + mesBR(x.mes)));
    if (x.emAndamento && x.situacao !== 'INCOMPLETO' && x.situacao !== 'DEPENDE') d.appendChild(el('p', { class: 'ir-frase' }, 'Mês em andamento: valor parcial, até hoje. O DARF se emite depois do fim do mês.'));
    if (x.situacao === 'INCOMPLETO') {
      d.appendChild(el('p', { class: 'aviso' }, 'Sem valor a pagar: este mês tem operação que não pôde ser calculada. Resolva em Pendências:'));
      var ul = el('ul', { class: 'ir-motivos' }); x.motivos.slice(0, 20).forEach(function (t) { ul.appendChild(el('li', null, t)); });
      d.appendChild(ul);
      if (x.motivos.length > 20) d.appendChild(el('p', { class: 'nota-tab' }, 'E mais ' + (x.motivos.length - 20) + ' motivo(s).'));
    }
    if (x.situacao === 'DEPENDE') d.appendChild(el('p', { class: 'aviso' }, 'Sem valor a pagar: depende de ' + mesBR(x.dependeDe) + ', que está incompleto. O prejuízo e o saldo de IRRF passam de um mês para o outro; quando aquele mês fechar, este mostra o valor.'));
    if (a && x.darf != null) {
      var isento = a.isencao20k;
      var fr = 'Vendas de ações à vista: ' + reais(a.vendasAcoes) + (a.vendasForaIsencao ? ' + ' + reais(a.vendasForaIsencao) + ' em day trade e exercício (contam no limite, premissa conservadora)' : '') + (isento ? ' → até R$ 20 mil: lucro de ações à vista isento' : ' → acima de R$ 20 mil: sem isenção') + '.';
      d.appendChild(el('p', { class: 'ir-frase' }, fr));
      if (a.lucroIsentoAcoes) d.appendChild(el('p', { class: 'ir-frase' }, 'Lucro isento neste mês: ' + reais(a.lucroIsentoAcoes) + ' (vai para Rendimentos Isentos na declaração).'));
      d.appendChild(tabelaCategorias(a));
      a.avisos.forEach(function (t) { d.appendChild(el('p', { class: 'aviso' }, t)); });
      if (a.darfAcumuladoAnterior) d.appendChild(el('p', { class: 'ir-frase' }, 'Inclui ' + reais(a.darfAcumuladoAnterior) + ' acumulados de meses abaixo de R$ 10.'));
      if (a.irrfParaDeclaracao) d.appendChild(el('p', { class: 'ir-frase' }, 'Saldo de IRRF não usado até o fim do ano: ' + reais((a.irrfParaDeclaracao.COMUM || 0) + (a.irrfParaDeclaracao.DAYTRADE || 0) + (a.irrfParaDeclaracao.FII || 0)) + '. Não passa para janeiro: informe na declaração.'));
      d.appendChild(blocoIrrf(x));
    }
    if (x.situacao === 'ACUMULA') d.appendChild(el('p', { class: 'ir-frase' }, 'Abaixo de R$ 10,00 não se emite DARF: ' + reais(x.acumulaParaProximo) + ' somam ao próximo mês com imposto.'));
    if (x.darf != null && x.darf > 0 && x.situacao !== 'PAGO' && !x.emAndamento) d.appendChild(blocoDarf(x));
    if (x.pago || (x.darf != null && x.darf > 0 && !x.emAndamento)) d.appendChild(blocoPago(x));
    return d;
  }
  function tabelaCategorias(a) {
    var wrap = el('div', { class: 'tabela-wrap' }), t = el('table', { class: 'tab-ir-cat' }), tr = el('tr');
    [['Categoria'], ['Resultado', 'a-dir'], ['Prejuízo anterior', 'a-dir'], ['Base', 'a-dir'], ['Alíq.', 'a-dir'], ['Imposto', 'a-dir'], ['IRRF', 'a-dir'], ['Prejuízo a compensar', 'a-dir']]
      .forEach(function (h) { tr.appendChild(el('th', { scope: 'col', class: h[1] }, h[0])); });
    add(t, add(el('thead'), tr));
    var tb = el('tbody'), NOME = { COMUM: 'Comum', DAYTRADE: 'Day trade', FII: 'FII/Fiagro' };
    ['COMUM', 'DAYTRADE', 'FII'].forEach(function (c) {
      var k = a.categorias[c];
      if (!k.resultado && !k.prejuizoAnterior && !k.irrfMes && !k.irrfAnterior && !k.imposto) return;
      var r = el('tr');
      r.appendChild(add(el('th', { scope: 'row' }), NOME[c]));
      add(r, el('td', { class: 'v num' + (k.resultado < 0 ? ' neg' : '') }, reaisSinal(k.resultado)), el('td', { class: 'v num' }, reais(k.prejuizoAnterior)), el('td', { class: 'v num' }, reais(k.base)),
        el('td', { class: 'v num' }, nf(k.aliquota * 100, 0) + '%'), el('td', { class: 'v num' }, reais(k.imposto)));
      var ci = el('td', { class: 'v num' }, reais(k.irrfDeduzido));
      if (k.irrfMes) ci.appendChild(el('span', { class: 'nota' }, reais(k.irrfMes) + (k.irrfOrigem === 'nota' ? ' da nota' : ' estimado')));
      if (k.irrfAnterior) ci.appendChild(el('span', { class: 'nota' }, reais(k.irrfAnterior) + ' de meses anteriores'));
      if (k.irrfSaldo) ci.appendChild(el('span', { class: 'nota' }, 'sobra ' + reais(k.irrfSaldo)));
      r.appendChild(ci);
      r.appendChild(el('td', { class: 'v num' }, reais(k.prejuizoAcumulado)));
      tb.appendChild(r);
    });
    if (!tb.firstChild) { var vaz = el('tr'); vaz.appendChild(el('td', { colspan: '8', class: 'muted' }, 'Nenhum resultado tributável neste mês.')); tb.appendChild(vaz); }
    t.appendChild(tb); wrap.appendChild(t); return wrap;
  }
  function blocoIrrf(x) {
    var c = atual(), inf = (c.irrf && temProp(c.irrf, x.mes)) ? c.irrf[x.mes] : null, est = temProp(E.res.irrfEstimado, x.mes) ? E.res.irrfEstimado[x.mes] : { COMUM: 0, DAYTRADE: 0, FII: 0 };
    var d = el('div', { class: 'ir-irrf' });
    d.appendChild(el('p', { class: 'sub-cad' }, 'IRRF retido pela corretora'));
    d.appendChild(el('p', { class: 'ir-frase' }, (inf ? 'Usando o valor da nota onde informado. ' : 'Estimado pelo site: ') + 'comum ' + reais(est.COMUM) + ' · day trade ' + reais(est.DAYTRADE) + ' · FII/Fiagro ' + reais(est.FII) + '. ' + (inf ? '' : 'Antes de pagar, confira com a nota de corretagem: vale o que foi retido.')));
    if (E.exemplo) return d;
    var ac = el('div', { class: 'acoes' });
    if (E.irForm !== 'irrf') {
      ac.appendChild(botao('Informar o valor da nota', function () { E.irForm = 'irrf'; desenharIR(); var f = $('#ir-comum'); if (f) f.focus(); }, 'Informar o IRRF da nota de ' + mesBR(x.mes)));
      if (inf) ac.appendChild(botao('Voltar à estimativa', function () { salvarIrrf(x.mes, null); }, 'Voltar à estimativa de IRRF de ' + mesBR(x.mes)));
      d.appendChild(ac); return d;
    }
    var g = el('div', { class: 'campos' });
    function val(k) { return inf && temProp(inf, k) ? numParaCampo(inf[k]) : ''; }
    add(g, campo('ir-comum', 'Comum, 0,005% (R$)', val('COMUM'), { inputmode: 'decimal', placeholder: 'vazio = estimativa' }),
      campo('ir-dt', 'Day trade, 1% (R$)', val('DAYTRADE'), { inputmode: 'decimal', placeholder: 'vazio = estimativa' }),
      campo('ir-fii', 'FII/Fiagro (R$)', val('FII'), { inputmode: 'decimal', placeholder: 'vazio = estimativa' }));
    d.appendChild(g);
    var sal = el('button', { class: 'btn prim', type: 'button' }, 'Salvar IRRF');
    sal.addEventListener('click', function () {
      var o = {}, ok = true;
      [['ir-comum', 'COMUM'], ['ir-dt', 'DAYTRADE'], ['ir-fii', 'FII']].forEach(function (p) {
        var n = lerNumero(v(p[0]), true);
        if (n == null) return;
        if (isNaN(n) || n < 0 || n > 1e9) { ok = false; var m = $('#ir-msg'); if (m) m.textContent = 'Valor inválido: "' + v(p[0]) + '". Use, por exemplo, 1,20; digite 0 se não houve retenção.'; return; }
        o[p[1]] = n;
      });
      if (ok) salvarIrrf(x.mes, Object.keys(o).length ? o : null);
    });
    add(ac, sal, botao('Cancelar', function () { E.irForm = null; desenharIR(); }));
    d.appendChild(ac);
    d.appendChild(el('p', { class: 'msg', id: 'ir-msg', role: 'status' }));
    return d;
  }
  async function salvarIrrf(mesAlvo, o) {
    var c = copiaCarteira();
    if (o) c.irrf[mesAlvo] = o; else delete c.irrf[mesAlvo];
    if (await gravar(c, o ? 'IRRF de ' + mesBR(mesAlvo) + ' salvo.' : 'IRRF de ' + mesBR(mesAlvo) + ' voltou à estimativa.')) { E.irForm = null; desenhar(); }
  }
  function blocoDarf(x) {
    var d = el('div', { class: 'ir-darf' });
    d.appendChild(el('p', { class: 'sub-cad' }, 'DARF para pagar'));
    var g = el('dl', { class: 'ir-campos' });
    [['Código da receita', '6015'], ['Período de apuração', mesBR(x.mes)], ['Valor principal', reais(x.darf)], ['Vencimento', dataBR(x.vencimento)]].forEach(function (p) {
      add(g, add(el('div'), el('dt', null, p[0]), el('dd', { class: 'num' }, p[1])));
    });
    d.appendChild(g);
    if (x.situacao === 'VENCIDO') d.appendChild(el('p', { class: 'aviso' }, 'Vencido: o valor acima é só o principal. O Sicalc soma a multa e os juros quando você informa a data do pagamento.'));
    var ol = el('ol', { class: 'ir-passos' });
    var p1 = el('li'); add(p1, 'Abra o ', el('a', { href: URL_SICALC, target: '_blank', rel: 'noopener noreferrer' }, 'Sicalc da Receita Federal'), ' e escolha "Preenchimento Rápido".');
    add(ol, p1, el('li', null, 'Informe seu CPF e a data de nascimento. O site não guarda nem envia esses dados.'),
      el('li', null, 'Preencha o código 6015, o período ' + mesBR(x.mes) + ' e o valor ' + reais(x.darf) + '. Se o vencimento do Sicalc for outro, vale o dele.'),
      el('li', null, 'Emita o DARF e pague no banco, em tributos federais.'),
      el('li', null, 'Volte aqui e registre o pagamento abaixo.'));
    d.appendChild(ol);
    return d;
  }
  function blocoPago(x) {
    var d = el('div', { class: 'ir-pago-b' });
    d.appendChild(el('p', { class: 'sub-cad' }, 'Já paguei'));
    if (x.pago) {
      d.appendChild(el('p', { class: 'ir-frase' }, 'Pagamento registrado: ' + reais(x.pago.valor) + ' em ' + dataBR(x.pago.pagoEm) + '.'));
      if (x.situacao === 'PAGO_DIFERENTE') d.appendChild(el('p', { class: 'aviso' }, x.diferenca > 0
        ? 'O cálculo agora dá ' + reais(x.darf) + ': faltam ' + reais(x.diferenca) + '. Algum lançamento mudou depois do pagamento; confira e, se estiver certo, pague a diferença.'
        : 'O cálculo agora dá ' + reais(x.darf || 0) + ': você pagou ' + reais(-x.diferenca) + ' a mais. Algum lançamento mudou depois do pagamento; se estiver certo, o caso é de restituição, com o contador.'));
      if (x.situacao === 'INCOMPLETO' || x.situacao === 'DEPENDE') d.appendChild(el('p', { class: 'ir-frase' }, 'Dá para comparar quando este mês mostrar o valor.'));
      if (!E.exemplo) d.appendChild(add(el('div', { class: 'acoes' }), botao('Remover o registro', function () { salvarPago(x.mes, null); }, 'Remover o pagamento de ' + mesBR(x.mes))));
      return d;
    }
    if (E.exemplo) return d;
    var g = el('div', { class: 'campos' });
    add(g, campo('ir-pago-data', 'Data do pagamento', hojeIso(), { type: 'date' }), campo('ir-pago-valor', 'Valor principal pago (R$)', x.darf.toFixed(2).replace('.', ','), { inputmode: 'decimal' }));
    d.appendChild(g);
    var b = el('button', { class: 'btn prim', type: 'button' }, 'Marcar como pago');
    b.addEventListener('click', function () {
      var dt = v('ir-pago-data'), n = lerNumero(v('ir-pago-valor'), true), msg = $('#ir-pago-msg');
      if (!/^\d{4}-\d\d-\d\d$/.test(dt || '')) { msg.textContent = 'Informe a data do pagamento.'; return; }
      if (n == null || isNaN(n) || n < 0.01 || n > 1e9) { msg.textContent = 'Informe o valor principal pago (ex.: 598,80).'; return; }
      salvarPago(x.mes, { pagoEm: dt, valor: n });
    });
    d.appendChild(add(el('div', { class: 'acoes' }), b));
    d.appendChild(el('p', { class: 'msg', id: 'ir-pago-msg', role: 'status' }));
    return d;
  }
  async function salvarPago(mesAlvo, o) {
    var c = copiaCarteira();
    if (o) c.darfs[mesAlvo] = o; else delete c.darfs[mesAlvo];
    if (await gravar(c, o ? 'Pagamento do DARF de ' + mesBR(mesAlvo) + ' registrado.' : 'Registro de pagamento de ' + mesBR(mesAlvo) + ' removido.')) desenhar();
  }

  /* ---------- posição ---------- */
  function desenharPosicao() {
    var box = $('#cart-posicao'); box.textContent = '';
    var lin = linhasPosicao();
    if (!lin.length) { box.appendChild(el('p', { class: 'muted' }, 'Nenhum ativo em carteira depois dos lançamentos.')); return; }
    var custoTotal = 0; lin.forEach(function (x) { if (x.p.qtd > 0 && !x.p.pmDesconhecido) custoTotal += x.p.qtd * x.p.pm; });
    var maisPos = el('div');
    lin = limitar(lin, 'pos', maisPos, 'ativos (ordem alfabética)', desenharPosicao);
    var wrap = el('div', { class: 'tabela-wrap' }), t = el('table', { class: 'tab-pos' });
    var th = el('thead'), tr = el('tr');
    [['Ativo'], ['Classe'], ['Qtd', 'a-dir'], ['Preço médio', 'a-dir'], ['Custo', 'a-dir'], ['Cotação de referência'], ['Resultado', 'a-dir'], ['Peso', 'a-dir']]
      .forEach(function (h) { tr.appendChild(el('th', { scope: 'col', class: h[1] }, h[0])); });
    th.appendChild(tr); t.appendChild(th);
    var tb = el('tbody');
    lin.forEach(function (x) {
      var p = x.p, r = el('tr');
      var c1 = el('td'); add(c1, el('strong', null, p.ativo));
      if (p.fracao) c1.appendChild(el('span', { class: 'nota' }, '+ fração ' + qtdBR(p.fracao.qtd) + ' aguardando leilão'));
      r.appendChild(c1);
      var cls = M.classificar(p.ativo, null, atual().classes || {});
      var tc = el('td', null, p.classe ? M.NOME_CLASSE[p.classe] : '');
      if (!p.classe) tc.appendChild(el('span', { class: 'ausente' }, '⚠ classificar'));
      else if (cls.origem === 'manual') tc.appendChild(el('span', { class: 'nota' }, 'classificação manual'));
      r.appendChild(tc);
      r.appendChild(el('td', { class: 'v num' }, qtdBR(p.qtd)));
      if (p.pmDesconhecido) { r.appendChild(el('td', { class: 'v ausente' }, '⚠ falta custo')); r.appendChild(el('td', { class: 'v' }, '—')); }
      else { r.appendChild(el('td', { class: 'v num' }, pm(p.pm))); r.appendChild(el('td', { class: 'v num' }, reais(p.qtd * p.pm))); }
      r.appendChild(celulaCotacao(p.ativo, x.cot));
      var cr = el('td', { class: 'v num' });
      if (x.nr) { cr.className = 'v num ' + (x.nr.resultado < 0 ? 'neg' : 'pos'); add(cr, reaisSinal(x.nr.resultado)); cr.appendChild(el('span', { class: 'nota' }, pct(x.nr.pct))); }
      else cr.textContent = '—';
      r.appendChild(cr);
      r.appendChild(el('td', { class: 'v num' }, (p.qtd > 0 && !p.pmDesconhecido && custoTotal) ? nf(p.qtd * p.pm / custoTotal * 100, 1) + '%' : '—'));
      tb.appendChild(r);
    });
    t.appendChild(tb); wrap.appendChild(t); box.appendChild(wrap);
    box.appendChild(el('p', { class: 'nota-tab' }, 'Peso pelo custo. Cotação digitada por você, com fonte e horário: referência para acompanhar, não para declarar (a declaração usa o custo).'));
    box.appendChild(maisPos);
  }
  function celulaCotacao(ativo, cot) {
    var td = el('td', { class: 'cot' });
    if (cot) {
      var idade = D.diasUteisDesde(cot.em.slice(0, 10));
      add(td, el('span', { class: 'num' }, 'R$ ' + nf(cot.valor, cot.valor < 1 ? 4 : 2)));
      var meta = el('span', { class: 'nota' }, (cot.fonte || 'fonte não informada') + ' · ' + dataHoraBR(cot.em));
      td.appendChild(meta);
      if (idade > 1) td.appendChild(el('span', { class: 'selo' }, 'desatualizada (' + idade + ' dias úteis)'));
    } else td.appendChild(el('span', { class: 'ausente' }, '⚠ falta cotação'));
    if (!E.exemplo) {
      var b = el('button', { class: 'btn mini', type: 'button', 'aria-label': (cot ? 'Atualizar cotação de ' : 'Digitar cotação de ') + ativo }, cot ? 'Atualizar' : 'Digitar');
      b.addEventListener('click', function () { abrirForm('COTACAO', null, { ativo: ativo }); });
      td.appendChild(b);
    }
    return td;
  }

  /* ---------- opções em aberto ---------- */
  function desenharOpcoes() {
    var box = $('#cart-opcoes'); box.textContent = '';
    var lista = E.res.opcoesAbertas || [], ref = dataRef();
    if (!lista.length) { box.appendChild(el('p', { class: 'muted' }, 'Nenhuma opção em aberto. Para lançar uma call ou put, use "+ Opção".')); return; }
    var maisOpc = el('div'), total = lista.length;
    lista = limitar(lista, 'opc', maisOpc, 'opções em aberto', desenharOpcoes);
    var wrap = el('div', { class: 'tabela-wrap' }), t = el('table', { class: 'tab-opc' }), tr = el('tr');
    [['Opção'], ['Posição'], ['Prêmio médio', 'a-dir'], ['Prêmio total', 'a-dir'], ['Ativo-objeto · strike'], ['Vencimento'], ['Situação'], ['', 'a-dir']]
      .forEach(function (h) { tr.appendChild(el('th', { scope: 'col', class: h[1] }, h[0])); });
    add(t, add(el('thead'), tr));
    var tb = el('tbody');
    lista.forEach(function (o) {
      var r = el('tr', { class: o.vencida ? 'com-pend' : null });
      var c1 = el('td'); add(c1, el('strong', null, o.ativo), el('span', { class: 'nota' }, o.tipo === 'CALL' ? 'call (compra)' : o.tipo === 'PUT' ? 'put (venda)' : 'tipo não informado'));
      r.appendChild(c1);
      var c2 = el('td', { class: 'num' }, o.qtd < 0 ? 'Vendida ' + qtdBR(-o.qtd) : 'Comprada ' + qtdBR(o.qtd));
      c2.appendChild(el('span', { class: 'nota' }, o.qtd < 0 ? 'lançador: recebeu o prêmio' : 'titular: pagou o prêmio'));
      r.appendChild(c2);
      r.appendChild(el('td', { class: 'v num' }, pm(o.pm)));
      r.appendChild(el('td', { class: 'v num' }, reais(Math.abs(o.qtd) * o.pm)));
      var c5 = el('td');
      if (o.cadastrada) { c5.textContent = (o.subjacente || '—') + ' · R$ ' + nf(o.strike, 2); }
      else c5.appendChild(el('span', { class: 'ausente' }, '⚠ sem cadastro'));
      r.appendChild(c5);
      var c6 = el('td', { class: 'num' });
      if (o.vencimento) {
        c6.textContent = dataBR(o.vencimento);
        var dias = Math.round((Date.parse(o.vencimento + 'T00:00:00Z') - Date.parse(ref + 'T00:00:00Z')) / 86400000);
        c6.appendChild(el('span', { class: o.vencida ? 'selo' : 'nota' }, o.vencida ? 'venceu: lance o resultado' : dias === 0 ? 'vence hoje' : 'em ' + dias + ' dia(s)'));
      } else c6.textContent = '—';
      r.appendChild(c6);
      var c7 = el('td');
      if (o.tipo === 'CALL' && o.qtd < 0 && o.subjacente && E.res.cobertura[o.subjacente]) {
        var cb = E.res.cobertura[o.subjacente];
        if (cb.descoberta > 0) c7.appendChild(el('span', { class: 'ausente' }, '⚠ descoberta: ' + qtdBR(cb.descoberta)));
        else c7.textContent = 'Coberta (' + qtdBR(cb.acoes) + ' ações)';
      } else if (o.tipo === 'PUT' && o.qtd < 0 && o.strike != null) {
        c7.textContent = 'Caixa para o exercício: ' + reais(-o.qtd * o.strike);
      } else c7.textContent = o.qtd > 0 ? 'Risco: o prêmio pago' : '—';
      r.appendChild(c7);
      var c8 = el('td', { class: 'acoes-lanc' });
      if (!E.exemplo) add(c8,
        botao('Virou pó', function () { abrirForm('VENCIMENTO', null, { ativo: o.ativo }); }, 'Lançar vencimento sem exercício de ' + o.ativo),
        botao('Exercício', function () { abrirForm('EXERCICIO', null, { ativo: o.ativo }); }, 'Lançar exercício de ' + o.ativo),
        botao(o.cadastrada ? 'Cadastro' : 'Cadastrar', function () { abrirForm('CADASTRO', null, { ativo: o.ativo }); }, 'Cadastro da opção ' + o.ativo));
      r.appendChild(c8);
      tb.appendChild(r);
    });
    t.appendChild(tb); wrap.appendChild(t); box.appendChild(wrap);
    var cx = E.res.caixaPuts, notas = [];
    if (cx && (cx.total > 0 || cx.semStrike.length)) notas.push('Caixa para o exercício de todas as puts vendidas: ' + reais(cx.total) + ' (strike × quantidade; o site não sabe o seu saldo em conta)' + (cx.semStrike.length ? '. Sem strike cadastrado: ' + cx.semStrike.join(', ') : '') + '.');
    notas.push('Prêmio médio com os custos da nota. Para zerar antes do vencimento, lance a recompra ou a venda em "+ Opção".');
    box.appendChild(el('p', { class: 'nota-tab' }, notas.join(' ')));
    box.appendChild(maisOpc);
  }

  /* ---------- campanhas (custo gerencial × fiscal) ---------- */
  function desenharCampanhas() {
    var box = $('#cart-campanhas'); box.textContent = '';
    var lista = (E.res.campanhas || []).filter(function (c) { return c.temOpcoes; })
      .sort(function (a, b) { return (a.aberta === b.aberta ? 0 : a.aberta ? -1 : 1) || (a.inicio < b.inicio ? 1 : a.inicio > b.inicio ? -1 : 0); });
    var maisCamp = el('div');
    if (lista.length) lista = limitar(lista, 'camp', maisCamp, 'campanhas', desenharCampanhas);
    if (!lista.length) { box.appendChild(el('p', { class: 'muted' }, 'Nenhuma campanha com opções ainda. Uma campanha junta, por ativo, as ações e as opções sobre elas: começa com a primeira operação e termina quando não sobra nenhuma.')); return; }
    var wrap = el('div', { class: 'tabela-wrap' }), t = el('table', { class: 'tab-camp' }), tr = el('tr');
    [['Ativo'], ['Período'], ['Ações', 'a-dir'], ['Custo fiscal', 'a-dir'], ['Opções realizadas', 'a-dir'], ['Custo gerencial', 'a-dir'], ['Resultado realizado', 'a-dir'], ['Prêmio em aberto', 'a-dir']]
      .forEach(function (h) { tr.appendChild(el('th', { scope: 'col', class: h[1] }, h[0])); });
    add(t, add(el('thead'), tr));
    var tb = el('tbody');
    lista.forEach(function (c) {
      var r = el('tr');
      var c1 = el('td'); add(c1, el('strong', null, c.subjacente), el('span', { class: 'nota' }, c.aberta ? 'aberta' : 'encerrada'));
      (c.aguardando || []).forEach(function (a) { c1.appendChild(el('span', { class: 'nota ausente' }, '⚠ aguardando o lançamento do vencimento: ' + a.ativo + ' (venceu em ' + dataBR(a.vencimento) + ')')); });
      r.appendChild(c1);
      r.appendChild(el('td', { class: 'num' }, dataBR(c.inicio) + ' → ' + (c.fim ? dataBR(c.fim) : 'hoje')));
      r.appendChild(el('td', { class: 'v num' }, c.aberta ? qtdBR(c.qtd) : '—'));
      var cf = el('td', { class: 'v num' }, c.aberta ? reais(c.custoFiscal) : '—');
      if (c.aberta && c.pmFiscal != null) cf.appendChild(el('span', { class: 'nota' }, 'PM ' + pm(c.pmFiscal)));
      if (c.aberta && c.premioNoCusto) cf.appendChild(el('span', { class: 'nota' }, 'inclui ' + reais(c.premioNoCusto) + ' de prêmio de exercício'));
      r.appendChild(cf);
      r.appendChild(el('td', { class: 'v num' + (c.resultadoOpcoes < 0 ? ' neg' : '') }, reaisSinal(c.resultadoOpcoes)));
      var cg = el('td', { class: 'v num' }, c.aberta ? reais(c.custoGerencial) : '—');
      if (c.aberta && c.pmGerencial != null) cg.appendChild(el('span', { class: 'nota' }, 'PM ' + pm(c.pmGerencial)));
      r.appendChild(cg);
      var rr = el('td', { class: 'v num' + (c.resultado < 0 ? ' neg' : c.resultado > 0 ? ' pos' : '') }, reaisSinal(c.resultado));
      if (c.incompleta) rr.appendChild(el('span', { class: 'nota ausente' }, '⚠ há operação não calculada'));
      r.appendChild(rr);
      r.appendChild(el('td', { class: 'v num' }, c.aberta && c.premioEmAberto ? reais(c.premioEmAberto) : '—'));
      tb.appendChild(r);
    });
    t.appendChild(tb); wrap.appendChild(t); box.appendChild(wrap);
    box.appendChild(maisCamp);
    box.appendChild(el('p', { class: 'nota-tab' }, 'Custo gerencial = custo fiscal − resultado realizado das opções do ativo na campanha (premissa; prêmio de opção ainda aberta não entra). Serve para acompanhar a estratégia; a declaração e o imposto usam o custo fiscal.'));
  }

  /* ---------- lançamentos ---------- */
  function acharLanc(id) { var c = atual(); return c ? c.lancamentos.filter(function (l) { return l.id === id; })[0] : null; }
  function ordenados() {
    return atual().lancamentos.slice().sort(function (a, b) {
      if (a.data !== b.data) return a.data < b.data ? 1 : -1;   // mais recente primeiro
      return (b.seq || 0) - (a.seq || 0);
    });
  }
  function descricao(l) {
    if (!l.tipo) return qtdBR(l.qtd) + ' × R$ ' + nf(l.preco, 2) + ' · custos ' + reais(l.custos) + (l.corretora ? ' · ' + l.corretora : '');
    switch (l.tipo) {
      case 'SALDO': return qtdBR(l.qtd) + ' a preço médio ' + (l.pm == null ? '⚠ não informado' : pm(l.pm));
      case 'DESDOBRAMENTO': case 'GRUPAMENTO': return qtdBR(l.de) + ' para ' + qtdBR(l.para);
      case 'BONIFICACAO': return 'a cada ' + qtdBR(l.de) + ' recebe ' + qtdBR(l.para) + ' · custo ' + (l.custoUnit == null ? '⚠ não informado' : pm(l.custoUnit) + ' por ação');
      case 'DIREITO_RECEBIDO': return qtdBR(l.qtd) + ' direito(s), custo zero';
      case 'SUBSCRICAO': return qtdBR(l.qtd) + ' × R$ ' + nf(l.preco, 2) + (l.direito ? ' · usa ' + l.direito : '');
      case 'EXPIRACAO': return 'não exercido nem vendido';
      case 'INCORPORACAO': return '→ ' + l.novoAtivo + ' · ' + qtdBR(l.proporcao) + ' nova(s) por ação';
      case 'LEILAO_FRACAO': return 'creditado ' + reais(l.valor);
      case 'VENCIMENTO': return 'virou pó (vencida sem exercício)';
      case 'EXERCICIO': return (l.qtd ? qtdBR(l.qtd) + ' opções' : 'toda a posição') + ' · ' + (l.tipoOpcao === 'PUT' ? 'put' : 'call') + ' a R$ ' + nf(l.strike, 2) + ' · ' + l.subjacente + (l.custos != null ? ' · custos ' + reais(l.custos) : '');
    }
    return '';
  }
  function desenharLancamentos() {
    var box = $('#cart-lanc'); box.textContent = '';
    var todos = ordenados(), pendIds = Object.create(null), LIM = E.limiteLanc || 300;
    E.res.pendencias.forEach(function (p) { if (p.id) pendIds[p.id] = true; });
    var lista = todos.slice(0, LIM);
    // Grupos do mesmo dia e fase, montados uma vez (evita varrer a lista por linha).
    var grupos = Object.create(null);
    todos.forEach(function (x) { var k = x.data + '|' + ordemDia(x); (grupos[k] = grupos[k] || []).push(x); });
    var wrap = el('div', { class: 'tabela-wrap' }), t = el('table', { class: 'tab-lanc' });
    var tr = el('tr');
    [['Data'], ['Tipo'], ['Ativo'], ['Detalhe'], ['', 'a-dir']].forEach(function (h) { tr.appendChild(el('th', { scope: 'col', class: h[1] }, h[0])); });
    add(t, add(el('thead'), tr));
    var tb = el('tbody');
    lista.forEach(function (l, i) {
      var r = el('tr', { class: pendIds[l.id] ? 'com-pend' : null });
      r.appendChild(el('td', { class: 'num' }, dataBR(l.data)));
      var tt = el('td', null, nomeTipo(l)); if (pendIds[l.id]) tt.appendChild(el('span', { class: 'ausente nota' }, '⚠ pendência'));
      r.appendChild(tt);
      r.appendChild(el('td', null, l.ativo));
      r.appendChild(el('td', { class: 'num' }, descricao(l)));
      var ac = el('td', { class: 'acoes-lanc' });
      if (!E.exemplo) {
        var mesmoDia = grupos[l.data + '|' + ordemDia(l)];
        if (mesmoDia.length > 1) {
          var pos = mesmoDia.indexOf(l);
          // lista exibida do mais recente para o mais antigo: "subir" = acontecer depois
          var sb = el('button', { class: 'btn-icone', type: 'button', 'aria-label': 'Mover para depois no mesmo dia', title: 'Aconteceu depois' }, '↑');
          sb.disabled = pos === 0; sb.addEventListener('click', function () { trocarOrdem(l, mesmoDia[pos - 1]); });
          var dc = el('button', { class: 'btn-icone', type: 'button', 'aria-label': 'Mover para antes no mesmo dia', title: 'Aconteceu antes' }, '↓');
          dc.disabled = pos === mesmoDia.length - 1; dc.addEventListener('click', function () { trocarOrdem(l, mesmoDia[pos + 1]); });
          add(ac, sb, dc);
        }
        var be = el('button', { class: 'btn mini', type: 'button' }, 'Editar'); be.addEventListener('click', function () { editar(l.id); });
        var bx = el('button', { class: 'btn mini', type: 'button' }, 'Excluir'); bx.addEventListener('click', function () { confirmarExclusao(l, r); });
        add(ac, be, bx);
      }
      r.appendChild(ac); tb.appendChild(r);
    });
    t.appendChild(tb); wrap.appendChild(t); box.appendChild(wrap);
    if (todos.length > lista.length) {
      var mais = el('button', { class: 'btn mini', type: 'button' }, 'Mostrar mais ' + Math.min(300, todos.length - lista.length) + ' (de ' + todos.length + ')');
      mais.addEventListener('click', function () { E.limiteLanc = LIM + 300; desenharLancamentos(); });
      box.appendChild(el('p', { class: 'nota-tab' }, 'Mostrando os ' + lista.length + ' lançamentos mais recentes. ')).appendChild(mais);
    }
    box.appendChild(el('p', { class: 'nota-tab' }, 'No mesmo dia, a ordem conta para o day trade (a Receita pareia o primeiro negócio de compra com o primeiro de venda). Use as setas para deixar na ordem da nota de corretagem.'));
  }
  function ordemDia(l) { return l.tipo === 'SALDO' ? 0 : (l.tipo && l.tipo !== 'VENCIMENTO' && l.tipo !== 'EXERCICIO') ? 1 : !l.tipo ? 2 : 3; }
  async function trocarOrdem(a, b) {
    if (!a || !b) return;
    var c = copiaCarteira();
    var la = c.lancamentos.filter(function (x) { return x.id === a.id; })[0], lb = c.lancamentos.filter(function (x) { return x.id === b.id; })[0];
    var s = la.seq; la.seq = lb.seq; lb.seq = s;
    la.atualizadoEm = lb.atualizadoEm = agoraIso();
    if (await gravar(c, 'Ordem do dia ' + dataBR(a.data) + ' alterada.')) desenhar();
  }
  function confirmarExclusao(l, linha) {
    var conf = $('#cart-status'); status('');
    var box = el('span', { class: 'conf-inline' });
    add(box, 'Excluir ' + nomeTipo(l).toLowerCase() + ' de ' + l.ativo + ' em ' + dataBR(l.data) + '? ');
    var sim = el('button', { class: 'btn mini perigo', type: 'button' }, 'Excluir');
    var nao = el('button', { class: 'btn mini', type: 'button' }, 'Cancelar');
    sim.addEventListener('click', async function () {
      var c = copiaCarteira(), antes = copiaCarteira();
      c.lancamentos = c.lancamentos.filter(function (x) { return x.id !== l.id; });
      if (await gravar(c, null)) { E.desfazer = antes; E.desfazerApos = JSON.stringify(E.carteira); desenhar(); mostrarDesfazer('Lançamento excluído.'); }
    });
    nao.addEventListener('click', function () { status(''); });
    add(box, sim, nao); conf.textContent = ''; conf.appendChild(box); sim.focus();
  }
  function mostrarDesfazer(t) {
    var st = $('#cart-status'); st.textContent = t + ' ';
    var b = el('button', { class: 'btn mini', type: 'button' }, 'Desfazer');
    b.addEventListener('click', async function () {
      if (!E.desfazer) return;
      // Só desfaz se a carteira ainda é a de logo depois da exclusão (7ª revisão, N4: backup importado no meio).
      if (JSON.stringify(E.carteira) !== E.desfazerApos) { E.desfazer = null; status('Não desfiz: a carteira mudou depois da exclusão.'); return; }
      var antes = E.desfazer; E.desfazer = null;
      if (await gravar(antes, 'Exclusão desfeita.')) desenhar();
    });
    st.appendChild(b);
  }

  /* ---------- resultados realizados ---------- */
  function desenharExtrato() {
    var box = $('#cart-extrato'); box.textContent = '';
    var lin = E.res.extrato.slice().reverse();
    if (!lin.length) { box.appendChild(el('p', { class: 'muted' }, 'Nenhuma venda, day trade ou leilão ainda.')); return; }
    var wrap = el('div', { class: 'tabela-wrap' }), t = el('table');
    var tr = el('tr');
    [['Data'], ['Ativo'], ['Operação'], ['Categoria'], ['Resultado', 'a-dir']].forEach(function (h) { tr.appendChild(el('th', { scope: 'col', class: h[1] }, h[0])); });
    add(t, add(el('thead'), tr));
    var tb = el('tbody');
    var NOME_CAT = { COMUM: 'Comum (15%)', DAYTRADE: 'Day trade (20%)', FII: 'FII/Fiagro (20%)', FORA: 'Fora do cálculo' };
    lin.slice(0, 200).forEach(function (x) {
      var r = el('tr');
      add(r, el('td', { class: 'num' }, dataBR(x.data)), el('td', null, x.ativo), el('td', null, x.descricao + (x.naoIsenta ? ' · não isenta' : '')),
        el('td', null, x.categoria ? NOME_CAT[x.categoria] : '⚠ sem classe'));
      var v = el('td', { class: 'v num' + (x.resultado == null ? ' ausente' : x.resultado < 0 ? ' neg' : '') }, x.resultado == null ? '⚠ não calculado' : reaisSinal(x.resultado));
      r.appendChild(v); tb.appendChild(r);
    });
    t.appendChild(tb); wrap.appendChild(t); box.appendChild(wrap);
    box.appendChild(el('p', { class: 'nota-tab' }, 'Resultado de cada operação, com custos. A apuração do mês (isenção de R$ 20 mil, prejuízos acumulados, IRRF e DARF) está em "Imposto de renda por mês".'));
  }

  function desenharRegras() {
    var box = $('#cart-regras'); box.textContent = '';
    var ul = el('ul', { class: 'regras' });
    [
      'Preço médio ponderado: compras somam preço e custos; vendas não mudam o preço médio (IN RFB 1.585/2015, art. 58). Posição zerada recomeça o médio. Média única por ativo, somando todas as corretoras.',
      'Custos de cada negócio: os da nota de corretagem rateados pelo valor (art. 56, § 4º). São obrigatórios: digite 0 se não houve.',
      'Day trade: compra e venda do mesmo ativo, no mesmo dia, na mesma corretora. O site pareia o primeiro negócio de compra com o primeiro de venda, em sequência (Perguntas e Respostas IRPF da Receita). Day trade não mexe no preço médio da carteira.',
      'Venda maior que a posição não é calculada: falta algum lançamento (saldo inicial, compra ou evento), e ele mudaria o preço médio.',
      'Eventos da empresa entram na data ex (primeiro dia sem direito), antes dos negócios do dia. Bonificação usa o custo atribuído informado pela empresa (art. 58, § 1º). Fração de grupamento, bonificação ou incorporação espera o valor do leilão; o leilão é tratado como venda à vista (premissa).',
      'Direito de subscrição recebido tem custo zero; a venda é tributada sem a isenção de R$ 20 mil (Solução de Consulta Cosit 166/2021). Incorporação transfere o custo sem apurar resultado, com aviso de possível ganho de capital.',
      'Units contam como ação (inclusive na isenção): premissa declarada. FII e Fiagro: 20%. FI-Infra e ETF de renda fixa têm tributação própria e ficam fora do cálculo.',
      'Opções: o resultado sai quando a posição fecha (venda do que foi comprado, recompra do que foi vendido), pelo prêmio médio com custos; 15% (20% no day trade), sem a isenção de R$ 20 mil. Opção que vira pó: perda do titular ou ganho do lançador na data do vencimento (IN RFB 1.585/2015, art. 60; Perguntas e Respostas IRPF 724 a 727).',
      'Exercício: titular de call compra as ações a strike + prêmio; lançador de call vende a strike + prêmio; titular de put vende a strike − prêmio; lançador de put compra a strike − prêmio. O lucro da venda de ações por exercício nunca é isento. Exercício parcial: informe a quantidade exercida.',
      'Ordem no dia: exercício que entrega ações (titular de call, lançador de put) entra antes dos negócios; vencimento e exercício que retira ações (lançador de call, titular de put) entram depois. Exercício não é day trade (IN RFB 1.585/2015, art. 65, § 13).',
      'Venda no mesmo dia do exercício que entrega ações: o resultado sai contra o custo do exercício (strike ± prêmio + custos), não contra o preço médio (Perguntas e Respostas IRPF 725 e 726). Até o tamanho do lote: 15%, sem a isenção de R$ 20 mil (premissa conservadora; caso para contador). Compra e venda da ação no mesmo dia pareiam antes, como day trade. O que sobra do lote entra no preço médio, e a venda em outro dia usa o preço médio.',
      'Opção negociada e não exercida: o resultado vem só dos prêmios de compra e de venda, sem strike. O vencimento sugerido pela letra do código (3ª sexta-feira, ou a n-ésima nas semanais) só pré-preenche o campo.',
      'Campanha: começa quando surge ação ou opção do ativo e fecha com o lançamento que zera tudo. Opção vencida sem lançamento deixa a campanha aberta, com o aviso "aguardando o lançamento do vencimento". Custo gerencial = custo fiscal − resultado realizado das opções do ativo na campanha (prêmio de opção ainda aberta não entra). A declaração usa o custo fiscal.',
      'Códigos terminados em 11 podem ser unit, ETF, FII ou Fiagro: o código não diz a classe. Você escolhe uma vez por ativo, em Pendências (fica a etiqueta "classificação manual"); a classe decide a alíquota e a isenção.',
      'Imposto do mês: comum 15%, day trade 20%, FII e Fiagro 20%. Prejuízo compensa só na mesma categoria, no mês e nos seguintes, sem prazo (ações, ETF, BDR e opções juntos na comum). Isenção: lucro de ações à vista com vendas de até R$ 20 mil no mês; volume de day trade e exercício conta no limite (premissa conservadora).',
      'IRRF estimado: 0,005% sobre as vendas à vista e sobre o saldo positivo dos prêmios do dia, por corretora, somando o mês; até R$ 1,00 não há retenção. 1% sobre o resultado positivo do day trade do dia (IN RFB 1.585/2015, arts. 63 e 65). A venda por exercício fica fora da estimativa (premissa conservadora). O valor da nota substitui a estimativa.',
      'Saldo de IRRF: fica na mesma categoria e vale até dezembro do ano da retenção (Perguntas e Respostas IRPF 714 e 715); o que sobra vai para a declaração. Mês incompleto não mostra valor, e os seguintes também não, porque prejuízo e saldo passam de um mês para o outro.',
      'DARF: código 6015, até o último dia útil do mês seguinte, pela lista de feriados do site; o Sicalc confirma. Abaixo de R$ 10,00 soma ao próximo mês com imposto.',
      'Regras verificadas em ' + dataBR(M.versaoRegras) + ' · motor de carteira v' + M.VERSAO + '. Cálculo de apoio, não substitui contador.'
    ].forEach(function (t) { ul.appendChild(el('li', null, t)); });
    box.appendChild(ul);
  }

  /* ================= formulários ================= */
  function abrirForm(tipo, id, pre) { E.form = { tipo: tipo, id: id || null, pre: pre || null, aviso: null }; desenharForm(); var f = $('#cart-form input, #cart-form select'); if (f) f.focus(); }
  function fecharForm() { E.form = null; desenharForm(); }
  function editar(id) {
    var l = acharLanc(id); if (!l) return;
    var tipoForm = l.tipo === 'SALDO' ? 'SALDO' : (l.tipo === 'VENCIMENTO' || l.tipo === 'EXERCICIO') ? l.tipo : l.tipo ? 'EVENTO' : ehOpcao(l.ativo) ? 'OPCAO' : 'NEGOCIO';
    abrirForm(tipoForm, id, l);
    $('#cart-form').scrollIntoView({ block: 'start' });
  }

  function campo(id, rotulo, valor, attrs, dica) {
    var d = el('div', { class: 'campo' });
    d.appendChild(el('label', { for: id }, rotulo));
    var i = el('input', Object.assign({ id: id, type: 'text', autocomplete: 'off' }, attrs || {}));
    i.value = valor == null ? '' : valor;
    d.appendChild(i);
    if (dica) d.appendChild(el('span', { class: 'dica' }, dica));
    return d;
  }
  function campoSel(id, rotulo, opcoes, valor) {
    var d = el('div', { class: 'campo' });
    d.appendChild(el('label', { for: id }, rotulo));
    var s = el('select', { id: id });
    opcoes.forEach(function (o) { var op = el('option', { value: o[0] }, o[1]); if (o[0] === valor) op.selected = true; s.appendChild(op); });
    d.appendChild(s);
    return d;
  }
  function hojeIso() { return D.hoje ? D.hoje() : new Date().toISOString().slice(0, 10); }
  function camposCadastro(cad, ativo) {
    var g = el('div', { class: 'campos campos-cad' });
    var tipoLetra = ativo ? M.classificar(ativo, null, null).tipoOpcao : null;
    add(g,
      campo('f-sub', 'Ativo-objeto', cad.subjacente || '', { maxlength: '12', autocapitalize: 'characters', placeholder: 'ex.: PETR4' }),
      campoSel('f-tipo', 'Tipo', [['', 'Escolha…'], ['CALL', 'Call (opção de compra)'], ['PUT', 'Put (opção de venda)']], cad.tipo || tipoLetra || ''),
      campo('f-strike', 'Strike (R$)', numParaCampo(cad.strike), { inputmode: 'decimal', placeholder: 'ex.: 35,00' }),
      campo('f-venc', 'Vencimento', cad.vencimento || (ativo ? M.vencimentoSugerido(ativo, hojeIso(), E.feriados) || '' : ''), { type: 'date' },
        cad.vencimento ? null : 'Sugestão pela letra do código: confira.'));
    return g;
  }
  /* Ao sair do campo do código: preenche só o que está vazio (tipo pela letra, vencimento sugerido, ativo-objeto se houver um único com a mesma raiz). */
  function autopreencher() {
    var a = document.getElementById('f-ativo'); if (!a) return;
    var t = M.normalizarTicker(a.value); if (!ehOpcao(t)) return;
    var tipo = document.getElementById('f-tipo'), venc = document.getElementById('f-venc'), sub = document.getElementById('f-sub'), dt = document.getElementById('f-data');
    var cad = cadastroDe(atual(), t);
    if (cad) {
      if (sub && !sub.value) sub.value = cad.subjacente; if (tipo && !tipo.value) tipo.value = cad.tipo;
      var st = document.getElementById('f-strike'); if (st && !st.value) st.value = numParaCampo(cad.strike);
      if (venc && !venc.value) venc.value = cad.vencimento;
      return;
    }
    if (tipo && !tipo.value) tipo.value = M.classificar(t, null, null).tipoOpcao || '';
    if (venc && !venc.value) venc.value = M.vencimentoSugerido(t, (dt && dt.value) || hojeIso(), E.feriados) || '';
    if (sub && !sub.value && E.res) {
      var raiz = t.slice(0, 4), cands = Object.keys(E.res.posicoes).filter(function (k) { return k.slice(0, 4) === raiz && E.res.posicoes[k].classe !== 'OPCAO' && E.res.posicoes[k].qtd > 0; });
      if (cands.length === 1) sub.value = cands[0];
    }
  }

  function desenharForm() {
    var box = $('#cart-form'); box.textContent = '';
    var f = E.form;
    box.hidden = !f || !!E.exemplo;
    if (!f || E.exemplo) return;
    var pre = f.pre || {};
    var cab = el('div', { class: 'cab-cenario' });
    var titulo = { NEGOCIO: 'Compra ou venda', OPCAO: 'Opção (compra ou venda)', SALDO: 'Saldo inicial', EVENTO: 'Evento da empresa', COTACAO: 'Cotação de referência — ' + (pre.ativo || ''),
      VENCIMENTO: 'Vencimento sem exercício — ' + (pre.ativo || ''), EXERCICIO: 'Exercício — ' + (pre.ativo || ''), CADASTRO: 'Cadastro da opção — ' + (pre.ativo || '') }[f.tipo];
    cab.appendChild(el('h2', null, (f.id ? 'Editar: ' : '') + titulo));
    box.appendChild(cab);
    var campos = el('div', { class: 'campos' });
    var explica = null;

    if (f.tipo === 'NEGOCIO') {
      add(campos,
        campo('f-data', 'Data do pregão', pre.data || hojeIso(), { type: 'date' }),
        campoSel('f-lado', 'Operação', [['C', 'Compra'], ['V', 'Venda']], pre.lado || 'C'),
        campo('f-ativo', 'Ativo (código)', pre.ativo || '', { placeholder: 'ex.: PETR4', maxlength: '12', autocapitalize: 'characters' }),
        campo('f-qtd', 'Quantidade', pre.qtd != null ? String(pre.qtd) : '', { inputmode: 'numeric', placeholder: 'ex.: 100' }),
        campo('f-preco', 'Preço por ação (R$)', numParaCampo(pre.preco), { inputmode: 'decimal', placeholder: 'ex.: 38,50' }),
        campo('f-custos', 'Custos da nota (R$)', numParaCampo(pre.custos), { inputmode: 'decimal', placeholder: 'digite 0 se não houve' }, 'Corretagem + emolumentos + liquidação desta operação.'),
        campo('f-corretora', 'Corretora', pre.corretora != null ? pre.corretora : 'Rico', { maxlength: '40' }));
    } else if (f.tipo === 'OPCAO') {
      var cadO = cadastroDe(atual(), pre.ativo) || {};
      add(campos,
        campo('f-data', 'Data do pregão', pre.data || hojeIso(), { type: 'date' }),
        campoSel('f-lado', 'Operação', [['V', 'Venda (lançar ou zerar compra)'], ['C', 'Compra (titular ou recompra)']], pre.lado || 'V'),
        campo('f-ativo', 'Código da opção', pre.ativo || '', { placeholder: 'ex.: PETRK350', maxlength: '12', autocapitalize: 'characters' }, 'Letra A–L = call, M–X = put.'),
        campo('f-qtd', 'Quantidade', pre.qtd != null ? String(pre.qtd) : '', { inputmode: 'numeric', placeholder: 'ex.: 100' }),
        campo('f-preco', 'Prêmio por opção (R$)', numParaCampo(pre.preco), { inputmode: 'decimal', placeholder: 'ex.: 0,85' }),
        campo('f-custos', 'Custos da nota (R$)', numParaCampo(pre.custos), { inputmode: 'decimal', placeholder: 'digite 0 se não houve' }, 'Corretagem + emolumentos + liquidação desta operação.'),
        campo('f-corretora', 'Corretora', pre.corretora != null ? pre.corretora : 'Rico', { maxlength: '40' }));
      box.appendChild(campos);
      box.appendChild(el('p', { class: 'sub-cad' }, 'Cadastro da opção (opcional agora)'));
      campos = camposCadastro(cadO, pre.ativo);
      explica = 'Cadastro (ativo-objeto, tipo, strike e vencimento): serve para a cobertura das calls, o caixa das puts, as campanhas e o aviso de vencimento. O imposto não depende dele. Sem o strike, o lançamento é salvo e o cadastro fica para depois, em Pendências.';
    } else if (f.tipo === 'CADASTRO') {
      campos = camposCadastro(cadastroDe(atual(), pre.ativo) || {}, pre.ativo);
      explica = 'Confira no home broker ou na nota. O vencimento sugerido pela letra do código (3ª sexta-feira do mês; nas semanais, a sexta indicada por W1–W5) é só um ponto de partida.';
    } else if (f.tipo === 'VENCIMENTO') {
      var cadV = cadastroDe(atual(), pre.ativo) || {};
      add(campos, campo('f-data', 'Data do vencimento', pre.data || cadV.vencimento || hojeIso(), { type: 'date' }));
      explica = 'A opção venceu sem exercício. Quem comprou perde o prêmio; quem vendeu ganha o prêmio, na data do vencimento.';
    } else if (f.tipo === 'EXERCICIO') {
      var cadE = cadastroDe(atual(), pre.ativo) || {};
      var posE = E.res && E.res.posicoes[pre.ativo] ? Math.abs(E.res.posicoes[pre.ativo].qtd) : null;
      var tipoE = pre.tipoOpcao || cadE.tipo || M.classificar(pre.ativo || '', null, null).tipoOpcao || 'CALL';
      add(campos,
        campo('f-data', 'Data do exercício', pre.data || cadE.vencimento || hojeIso(), { type: 'date' }),
        campo('f-qtd', 'Quantidade exercida', pre.qtd != null ? String(pre.qtd) : (posE ? String(posE) : ''), { inputmode: 'numeric' }, posE ? 'Em carteira: ' + qtdBR(posE) + '. Menos que isso = exercício parcial.' : null),
        campoSel('f-tipo', 'Tipo', [['CALL', 'Call (opção de compra)'], ['PUT', 'Put (opção de venda)']], tipoE),
        campo('f-strike', 'Strike (R$)', numParaCampo(pre.strike != null ? pre.strike : cadE.strike), { inputmode: 'decimal', placeholder: 'ex.: 35,00' }),
        campo('f-sub', 'Ativo-objeto', pre.subjacente || cadE.subjacente || '', { maxlength: '12', autocapitalize: 'characters', placeholder: 'ex.: PETR4' }),
        campo('f-custos', 'Custos do exercício (R$)', numParaCampo(pre.custos), { inputmode: 'decimal', placeholder: 'digite 0 se não houve' }, 'Taxas da nota do exercício.'));
      explica = 'Titular de call compra as ações a strike + prêmio; lançador de call vende a strike + prêmio; titular de put vende a strike − prêmio; lançador de put compra a strike − prêmio. Exercício que entrega ações entra antes dos negócios do dia, e a venda no mesmo dia sai contra o custo do exercício, sem isenção. O que retira ações entra depois.';
    } else if (f.tipo === 'SALDO') {
      add(campos,
        campo('f-data', 'Data de início', pre.data || hojeIso(), { type: 'date' }),
        campo('f-ativo', 'Ativo (código)', pre.ativo || '', { placeholder: 'ex.: PETR4', maxlength: '12', autocapitalize: 'characters' }),
        campo('f-qtd', 'Quantidade', pre.qtd != null ? String(pre.qtd) : '', { inputmode: 'numeric', placeholder: 'ex.: 300' }),
        campo('f-pm', 'Preço médio (R$, com taxas)', numParaCampo(pre.pm), { inputmode: 'decimal', placeholder: 'ex.: 27,35' }, 'O da sua corretora ou do seu controle. Vazio vira pendência.'));
      explica = 'Posição no início do dia escolhido, somando todas as corretoras. Lançamentos anteriores a essa data não devem ser repetidos aqui.';
    } else if (f.tipo === 'EVENTO') {
      var t = pre.tipo || 'DESDOBRAMENTO';
      var sel = campoSel('f-evento', 'Evento', EVENTOS_TELA.map(function (e) { return [e, NOME_EVENTO[e]]; }), t);
      if (f.id) sel.querySelector('select').disabled = true;
      add(campos, sel, campo('f-data', 'Data ex (primeiro dia sem direito)', pre.data || hojeIso(), { type: 'date' }),
        campo('f-ativo', t === 'DIREITO_RECEBIDO' || t === 'EXPIRACAO' ? 'Código do direito' : 'Ativo (código)', pre.ativo || '', { placeholder: t === 'DIREITO_RECEBIDO' || t === 'EXPIRACAO' ? 'ex.: PETR1' : 'ex.: PETR4', maxlength: '12', autocapitalize: 'characters' }));
      if (t === 'DESDOBRAMENTO' || t === 'GRUPAMENTO') {
        add(campos, campo('f-de', 'De (ações)', numParaCampo(pre.de != null ? pre.de : (t === 'GRUPAMENTO' ? 10 : 1)), { inputmode: 'decimal' }),
          campo('f-para', 'Para (ações)', numParaCampo(pre.para != null ? pre.para : (t === 'GRUPAMENTO' ? 1 : 2)), { inputmode: 'decimal' }));
        explica = t === 'DESDOBRAMENTO' ? 'Ex.: 1 para 2 dobra a quantidade e divide o preço médio por 2. O custo total não muda.' : 'Ex.: 10 para 1. Sobra de fração espera o leilão.';
      } else if (t === 'BONIFICACAO') {
        add(campos, campo('f-de', 'A cada (ações)', numParaCampo(pre.de != null ? pre.de : 10), { inputmode: 'decimal' }),
          campo('f-para', 'Recebe (ações)', numParaCampo(pre.para != null ? pre.para : 1), { inputmode: 'decimal' }),
          campo('f-custo', 'Custo atribuído por ação (R$)', numParaCampo(pre.custoUnit), { inputmode: 'decimal', placeholder: 'do aviso aos acionistas' }, 'Vazio vira pendência (vendas seguintes não são calculadas).'));
        explica = 'O custo atribuído está no aviso aos acionistas ou fato relevante da empresa. Ex.: 10% de bonificação = a cada 10 recebe 1.';
      } else if (t === 'DIREITO_RECEBIDO') {
        add(campos, campo('f-qtd', 'Quantidade de direitos', pre.qtd != null ? String(pre.qtd) : '', { inputmode: 'numeric' }));
        explica = 'Direito recebido por ser acionista tem custo zero. Para vender, lance uma venda com o código do direito; para exercer, lance "Subscrição exercida".';
      } else if (t === 'SUBSCRICAO') {
        add(campos, campo('f-qtd', 'Ações subscritas', pre.qtd != null ? String(pre.qtd) : '', { inputmode: 'numeric' }),
          campo('f-preco', 'Preço por ação (R$)', numParaCampo(pre.preco), { inputmode: 'decimal' }),
          campo('f-direito', 'Código do direito usado (opcional)', pre.direito || '', { maxlength: '12', autocapitalize: 'characters', placeholder: 'ex.: PETR1' }));
        explica = 'Use a data em que as ações foram creditadas. Cada ação subscrita consome um direito (o custo dele, se você comprou, entra no preço médio).';
      } else if (t === 'EXPIRACAO') {
        explica = 'Direito que não foi exercido nem vendido até o prazo.';
      } else if (t === 'INCORPORACAO') {
        add(campos, campo('f-novo', 'Novo ativo (código)', pre.novoAtivo || '', { maxlength: '12', autocapitalize: 'characters' }),
          campo('f-prop', 'Ações novas por ação antiga', numParaCampo(pre.proporcao), { inputmode: 'decimal', placeholder: 'ex.: 0,5' }));
        explica = 'Também serve para conversão de espécie (ex.: PN em ON). O custo é transferido sem apurar resultado; o site avisa sobre possível ganho de capital.';
      } else if (t === 'LEILAO_FRACAO') {
        add(campos, campo('f-valor', 'Valor creditado (R$)', numParaCampo(pre.valor), { inputmode: 'decimal' }));
        explica = 'Valor recebido pela venda da fração no leilão (no extrato da corretora). Entra como venda à vista.';
      }
    } else if (f.tipo === 'COTACAO') {
      var cot = (atual().cotacoes || {})[pre.ativo] || {};
      var agora = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      add(campos, campo('f-cot', 'Cotação (R$)', numParaCampo(cot.valor), { inputmode: 'decimal', placeholder: 'ex.: 38,72' }),
        campo('f-fonte', 'Fonte', cot.fonte || '', { maxlength: '80', placeholder: 'ex.: home broker Rico' }),
        campo('f-em', 'Data e hora da cotação', cot.em || agora, { type: 'datetime-local' }));
      explica = 'Referência para acompanhar o resultado não realizado. Não muda preço médio nem imposto.';
    }
    box.appendChild(campos);
    if (explica) box.appendChild(el('p', { class: 'explica' }, explica));
    if (f.aviso) box.appendChild(f.aviso);
    var acoes = el('div', { class: 'acoes' });
    var salvar = el('button', { class: 'btn prim', type: 'button' }, f.tipo === 'COTACAO' ? 'Salvar cotação' : f.tipo === 'CADASTRO' ? 'Salvar cadastro' : 'Salvar lançamento');
    salvar.addEventListener('click', function () { salvarForm(false); });
    var cancelar = el('button', { class: 'btn', type: 'button' }, 'Cancelar');
    cancelar.addEventListener('click', fecharForm);
    add(acoes, salvar, cancelar);
    box.appendChild(acoes);
    var msg = el('p', { class: 'msg', id: 'f-msg', role: 'status' }); box.appendChild(msg);
    if (f.tipo === 'OPCAO') { var fa = document.getElementById('f-ativo'); if (fa) fa.addEventListener('change', autopreencher); }
    var evSel = $('#f-evento');
    if (evSel) evSel.addEventListener('change', function () { E.form.pre = Object.assign({}, lerParcial(), { tipo: evSel.value }); desenharForm(); $('#f-evento').focus(); });
  }
  function v(id) { var e = document.getElementById(id); return e ? e.value : null; }
  function lerParcial() { return { data: v('f-data'), ativo: v('f-ativo') }; }
  function erroForm(t, foco) { var m = $('#f-msg'); if (m) m.textContent = t; if (foco && document.getElementById(foco)) document.getElementById(foco).focus(); }

  function inteiro(id, nome) {
    var n = lerNumero(v(id));
    if (n == null || isNaN(n)) { erroForm('Informe ' + nome + '.', id); return null; }
    if (!Number.isInteger(n) || n < 1) { erroForm(nome.charAt(0).toUpperCase() + nome.slice(1) + ' tem de ser um número inteiro maior que zero (você digitou "' + v(id) + '").', id); return null; }
    return n;
  }
  function decimal(id, nome, opcional, minimo) {
    var n = lerNumero(v(id), true);
    if (n == null) { if (opcional) return undefined; erroForm('Informe ' + nome + '.', id); return null; }
    if (isNaN(n) || n < (minimo || 0)) { erroForm(nome.charAt(0).toUpperCase() + nome.slice(1) + ' inválido(a): "' + v(id) + '".', id); return null; }
    return n;
  }
  function ticker(id) {
    var t = M.normalizarTicker(v(id));
    if (!/^[A-Z0-9]{4,12}$/.test(t)) { erroForm('Código de ativo inválido (ex.: PETR4, TAEE11).', id); return null; }
    return t;
  }

  /* Monta o lançamento do formulário; null = erro já mostrado. */
  function montar() {
    var f = E.form, pre = f.pre || {};
    var data = v('f-data');
    if (!/^\d{4}-\d\d-\d\d$/.test(data || '')) { erroForm('Informe a data.', 'f-data'); return null; }
    var ativo = (f.tipo === 'VENCIMENTO' || f.tipo === 'EXERCICIO') ? pre.ativo : ticker('f-ativo'); if (!ativo) return null;
    var base = { id: f.id || novoId(), data: data, ativo: ativo, origem: 'manual' };
    if (f.tipo === 'OPCAO') {
      if (!ehOpcao(ativo)) { erroForm('Código de opção não reconhecido (ex.: PETRK350, PETRW300, B3SAB11W1).', 'f-ativo'); return null; }
      var qo = inteiro('f-qtd', 'a quantidade'); if (qo == null) return null;
      var po = decimal('f-preco', 'o prêmio', false, 0.000001); if (po == null) return null;
      var co = decimal('f-custos', 'os custos da nota (digite 0 se não houve)'); if (co == null) return null;
      return Object.assign(base, { lado: v('f-lado') === 'C' ? 'C' : 'V', qtd: qo, preco: po, custos: co, corretora: (v('f-corretora') || '').trim().slice(0, 40) });
    }
    if (f.tipo === 'VENCIMENTO') return Object.assign(base, { tipo: 'VENCIMENTO' });
    if (f.tipo === 'EXERCICIO') {
      var qe = inteiro('f-qtd', 'a quantidade exercida'); if (qe == null) return null;
      var tp = v('f-tipo') === 'PUT' ? 'PUT' : 'CALL';
      var sk = decimal('f-strike', 'o strike', false, 0.0001); if (sk == null) return null;
      var sb = ticker('f-sub'); if (!sb) return null;
      if (ehOpcao(sb)) { erroForm('O ativo-objeto é a ação ou o ETF (ex.: PETR4), não a opção.', 'f-sub'); return null; }
      var ce = decimal('f-custos', 'os custos do exercício (digite 0 se não houve)'); if (ce == null) return null;
      Object.assign(base, { tipo: 'EXERCICIO', subjacente: sb, tipoOpcao: tp, strike: sk, custos: ce });
      var posQ = E.res && E.res.posicoes[ativo] ? Math.abs(E.res.posicoes[ativo].qtd) : null;
      var antigoQ = f.id && pre.qtd != null;
      if (antigoQ || posQ == null || qe !== posQ) base.qtd = qe;   // quantidade explícita quando parcial (ou já gravada assim)
      return base;
    }
    if (f.tipo === 'NEGOCIO') {
      var q = inteiro('f-qtd', 'a quantidade'); if (q == null) return null;
      var p = decimal('f-preco', 'o preço', false, 0.000001); if (p == null) return null;
      var c = decimal('f-custos', 'os custos da nota (digite 0 se não houve)'); if (c == null) return null;
      return Object.assign(base, { lado: v('f-lado') === 'V' ? 'V' : 'C', qtd: q, preco: p, custos: c, corretora: (v('f-corretora') || '').trim().slice(0, 40) });
    }
    if (f.tipo === 'SALDO') {
      var qs = inteiro('f-qtd', 'a quantidade'); if (qs == null) return null;
      var pmv = decimal('f-pm', 'o preço médio', true); if (pmv === null) return null;
      return Object.assign(base, { tipo: 'SALDO', qtd: qs, pm: pmv === undefined ? null : pmv });
    }
    var t = f.id ? pre.tipo : v('f-evento');
    base.tipo = t;
    if (t === 'DESDOBRAMENTO' || t === 'GRUPAMENTO' || t === 'BONIFICACAO') {
      var de = decimal('f-de', 'o "de"', false, 0.000001); if (de == null) return null;
      var para = decimal('f-para', 'o "para"', false, 0.000001); if (para == null) return null;
      base.de = de; base.para = para;
      if (t === 'DESDOBRAMENTO' && para <= de) { erroForm('No desdobramento a quantidade aumenta (ex.: 1 para 2). Para reduzir, escolha "Grupamento".', 'f-para'); return null; }
      if (t === 'GRUPAMENTO' && para >= de) { erroForm('No grupamento a quantidade diminui (ex.: 10 para 1).', 'f-para'); return null; }
      if (t === 'BONIFICACAO') { var cu = decimal('f-custo', 'o custo atribuído', true); if (cu === null) return null; base.custoUnit = cu === undefined ? null : cu; }
      return base;
    }
    if (t === 'DIREITO_RECEBIDO') { var qd = inteiro('f-qtd', 'a quantidade'); if (qd == null) return null; base.qtd = qd; return base; }
    if (t === 'SUBSCRICAO') {
      var qq = inteiro('f-qtd', 'a quantidade'); if (qq == null) return null;
      var pp = decimal('f-preco', 'o preço'); if (pp == null) return null;
      base.qtd = qq; base.preco = pp;
      if ((v('f-direito') || '').trim()) { var d = ticker('f-direito'); if (!d) return null; base.direito = d; }
      return base;
    }
    if (t === 'EXPIRACAO') return base;
    if (t === 'INCORPORACAO') {
      var nv = ticker('f-novo'); if (!nv) return null;
      if (nv === ativo) { erroForm('O novo ativo tem de ser diferente do antigo.', 'f-novo'); return null; }
      var pr = decimal('f-prop', 'a proporção', false, 0.000001); if (pr == null) return null;
      base.novoAtivo = nv; base.proporcao = pr; return base;
    }
    if (t === 'LEILAO_FRACAO') { var vl = decimal('f-valor', 'o valor'); if (vl == null) return null; base.valor = vl; return base; }
    erroForm('Escolha o evento.', 'f-evento'); return null;
  }

  /* Cadastro da opção a partir dos campos: undefined = cadastrar depois; null = erro já mostrado.
     No lançamento (opcional = true), strike vazio deixa o cadastro para depois: tipo, vencimento e ativo-objeto vêm pré-preenchidos,
     e o strike não sai do código com segurança. Antes da v0.11.0, isso impedia salvar a operação. */
  function lerCadastro(ativo, opcional) {
    var sub = (v('f-sub') || '').trim(), tipo = v('f-tipo') || '', st = (v('f-strike') || '').trim(), vc = v('f-venc') || '';
    if (!sub && !tipo && !st && !vc) return undefined;
    if (opcional && !st) return undefined;
    var sb = ticker('f-sub'); if (!sb) return null;
    if (sb === ativo || ehOpcao(sb)) { erroForm('O ativo-objeto é a ação ou o ETF (ex.: PETR4), não a opção.', 'f-sub'); return null; }
    if (tipo !== 'CALL' && tipo !== 'PUT') { erroForm('Escolha o tipo (call ou put).', 'f-tipo'); return null; }
    var k = decimal('f-strike', 'o strike', false, 0.0001); if (k == null) return null;
    if (!/^\d{4}-\d\d-\d\d$/.test(vc)) { erroForm('Informe o vencimento (ou deixe os quatro campos do cadastro vazios).', 'f-venc'); return null; }
    return { subjacente: sb, tipo: tipo, strike: k, vencimento: vc };
  }
  async function salvarCadastro() {
    var ativo = E.form.pre.ativo, cd = lerCadastro(ativo);
    if (cd === null) return;
    if (cd === undefined) { erroForm('Preencha o ativo-objeto, o tipo, o strike e o vencimento.', 'f-sub'); return; }
    var c = copiaCarteira(); c.opcoes[ativo] = cd;
    if (await gravar(c, 'Cadastro de ' + ativo + ' salvo.')) { E.form = null; desenhar(); }
  }

  async function salvarForm(forcar) {
    var f = E.form; if (!f) return;
    if (f.tipo === 'COTACAO') return salvarCotacao();
    if (f.tipo === 'CADASTRO') return salvarCadastro();
    var l = montar(); if (!l) return;
    var cadNovo;
    if (f.tipo === 'OPCAO') { cadNovo = lerCadastro(l.ativo, true); if (cadNovo === null) return; }
    var c = copiaCarteira(), antigo = f.id ? c.lancamentos.filter(function (x) { return x.id === f.id; })[0] : null;
    if (cadNovo) c.opcoes[l.ativo] = cadNovo;
    var semCad = f.tipo === 'OPCAO' && !cadNovo && !temProp(c.opcoes, l.ativo);
    var agora = agoraIso();
    if (antigo) { l.seq = antigo.seq; l.criadoEm = antigo.criadoEm; l.atualizadoEm = agora; c.lancamentos = c.lancamentos.map(function (x) { return x.id === f.id ? l : x; }); }
    else { l.seq = c.lancamentos.reduce(function (m, x) { return Math.max(m, x.seq || 0); }, 0) + 1; l.criadoEm = agora; c.lancamentos.push(l); }
    var erro = D.validarLancamento(l);
    if (erro) { erroForm('Não salvei: ' + erro + '.'); return; }
    // Venda acima da posição: alerta e quantidade editável antes de gravar (decisão do Leo, 31/10/2026).
    if (!forcar && !l.tipo && l.lado === 'V') {
      var r = M.processar(c.lancamentos, opcoesMotor(c));
      var p = r.pendencias.filter(function (x) { return x.tipo === 'VENDA_ACIMA' && x.id === l.id; })[0];
      if (p) {
        var box = el('div', { class: 'confirma' });
        add(box, el('div', null, 'Em ' + dataBR(l.data) + ' havia ' + qtdBR(p.disponivel) + ' ' + l.ativo + ' na carteira; a venda é de ' + qtdBR(l.qtd) + '. Se a quantidade estiver certa, falta lançar uma compra, o saldo inicial, o exercício de uma opção ou um evento (bonificação, desdobramento). Salvando assim, a venda fica em Pendências e não é calculada.'));
        var ac = el('div', { class: 'acoes' });
        if (p.disponivel > 0) {
          var usar = el('button', { class: 'btn prim', type: 'button' }, 'Vender ' + qtdBR(p.disponivel));
          usar.addEventListener('click', function () { document.getElementById('f-qtd').value = String(p.disponivel); E.form.aviso = null; salvarForm(false); });
          ac.appendChild(usar);
        }
        var assim = el('button', { class: 'btn', type: 'button' }, 'Salvar assim mesmo');
        assim.addEventListener('click', function () { salvarForm(true); });
        var corrigir = el('button', { class: 'btn', type: 'button' }, 'Corrigir a quantidade');
        corrigir.addEventListener('click', function () { var q = document.getElementById('f-qtd'); q.focus(); q.select(); });
        add(ac, assim, corrigir); box.appendChild(ac);
        var vals = lerValoresForm(); E.form.aviso = box; desenharForm(); restaurarValoresForm(vals);
        return;
      }
    }
    if (await gravar(c, (antigo ? 'Lançamento alterado: ' : 'Lançamento salvo: ') + nomeTipo(l).toLowerCase() + ' de ' + l.ativo + ' em ' + dataBR(l.data) + '.' + (semCad ? ' O cadastro da opção ficou para depois (sem strike): ele aparece em Pendências.' : ''))) { E.form = null; desenhar(); }
  }
  function lerValoresForm() { var o = {}; document.querySelectorAll('#cart-form input, #cart-form select').forEach(function (i) { o[i.id] = i.value; }); return o; }
  function restaurarValoresForm(o) { Object.keys(o).forEach(function (k) { var i = document.getElementById(k); if (i) i.value = o[k]; }); }

  async function salvarCotacao() {
    var ativo = E.form.pre.ativo;
    var val = decimal('f-cot', 'a cotação', false, 0.000001); if (val == null) return;
    var fonte = (v('f-fonte') || '').trim();
    if (!fonte) { erroForm('Informe a fonte (ex.: home broker Rico).', 'f-fonte'); return; }
    var em = v('f-em') || '';
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(em)) { erroForm('Informe data e hora da cotação.', 'f-em'); return; }
    var c = copiaCarteira(); c.cotacoes[ativo] = { valor: val, fonte: fonte.slice(0, 80), em: em };
    if (await gravar(c, 'Cotação de ' + ativo + ' salva.')) { E.form = null; desenhar(); }
  }

  /* ================= gravação (só pela Porta) ================= */
  function copiaCarteira() { var c = JSON.parse(JSON.stringify(E.carteira || vazia())); c.classes = c.classes || {}; c.cotacoes = c.cotacoes || {}; c.opcoes = c.opcoes || {}; c.irrf = c.irrf || {}; c.darfs = c.darfs || {}; return c; }
  async function gravar(c, texto) {
    if (E.exemplo) { status('No exemplo nada é gravado.'); return false; }
    try {
      await D.gravar('carteira', c);
      E.carteira = c;
      anunciarCarteira();
      if (texto) status(texto);
      return true;
    } catch (e) {
      var m = $('#f-msg');
      var t = 'Não salvei (' + e.message + ').';
      if (m && E.form) m.textContent = t; else status(t);
      return false;
    }
  }

  /* ================= exemplo (dados fictícios, só na memória) ================= */
  async function carregarExemplo() {
    try {
      var ex = await D.carteiraExemplo();
      E.mesIR = null; E.exemplo = { versao: 1, lancamentos: ex.lancamentos, classes: ex.classes || {}, cotacoes: ex.cotacoes || {}, opcoes: ex.opcoes || {}, irrf: {}, darfs: {},
        dataReferencia: /^\d{4}-\d\d-\d\d$/.test(ex.dataReferencia || '') ? ex.dataReferencia : null };
      E.form = null; status(''); desenhar();
    } catch (e) { status('Não consegui abrir o exemplo (' + e.message + ').'); }
  }
  function sairExemplo() { E.exemplo = null; E.mesIR = null; status(''); desenhar(); }

  /* ================= início ================= */
  /* A aba Rendimentos recebe a carteira por aqui e não a lê pela Porta: ler lá atualizaria a versão lida por aba e esconderia
     desta tela uma gravação feita em outra aba (defesa N3 da 7ª revisão). Nunca passa o exemplo. */
  function anunciarCarteira() { document.dispatchEvent(new CustomEvent('cf:carteira', { detail: { carteira: E.carteira } })); }
  document.addEventListener('cf:pedir-carteira', function () { if (E.carteira || E.ilegivel) anunciarCarteira(); });
  async function carregar() {
    try { var fj = await D.feriados(); E.feriados = Array.isArray(fj.feriados) ? fj.feriados : []; } catch (e) { E.feriados = []; }
    try {
      var c = await D.ler('carteira');
      E.carteira = c || vazia(); E.ilegivel = false;
    } catch (e) {
      E.carteira = null; E.ilegivel = true;
      status('Os dados da carteira guardados neste navegador não puderam ser lidos (veja o aviso no topo). Nada será gravado por cima.');
    }
    desenhar();
    anunciarCarteira();
  }

  $('#cart-novo-neg').addEventListener('click', function () { abrirForm('NEGOCIO'); });
  $('#cart-novo-opcao').addEventListener('click', function () { abrirForm('OPCAO'); });
  $('#cart-novo-saldo').addEventListener('click', function () { abrirForm('SALDO'); });
  $('#cart-novo-evento').addEventListener('click', function () { abrirForm('EVENTO'); });
  $('#cart-vazio-saldo').addEventListener('click', function () { abrirForm('SALDO'); });
  $('#cart-exemplo').addEventListener('click', carregarExemplo);
  $('#cart-vazio-exemplo').addEventListener('click', carregarExemplo);
  document.addEventListener('cf:dados-restaurados', function () { E.desfazer = null; E.form = null; status(''); carregar(); });
  document.addEventListener('cf:backup-exportado', function () { if (!E.exemplo) desenharBackup(); });
  carregar();
})();
