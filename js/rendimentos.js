/*
 * Controle Financeiro — Rendimentos (F5): proventos confirmados, aluguel de ações, rendimentos por mês e por tipo, alerta de
 * R$ 50 mil por empresa e, em tela separada, proventos estimados pelo histórico. Lê e grava só por window.Dados (chave `proventos`);
 * calcula só com window.MotorCarteira. A carteira chega por evento de js/carteira.js: esta tela nunca a lê pela Porta, para não
 * atualizar a versão lida por aba e esconder de carteira.js uma gravação feita em outra aba (defesa N3 da 7ª revisão).
 * Nenhuma fórmula financeira aqui: a tela converte texto em número, monta os itens e mostra o resultado do motor.
 */
(function () {
  'use strict';
  var D = window.Dados, M = window.MotorCarteira;
  var $ = function (s) { return document.querySelector(s); };
  if (!$('#rendimentos') || !M || !D) return;

  /* ================= formatação pt-BR ================= */
  var BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  function reais(v) { return typeof v === 'number' && isFinite(v) ? BRL.format(v) : '—'; }
  function qtdBR(v) { return typeof v === 'number' && isFinite(v) ? v.toLocaleString('pt-BR', { maximumFractionDigits: 6 }) : '—'; }
  function porAcao(v) { return typeof v === 'number' && isFinite(v) ? 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 8 }) : '—'; }
  function pctBR(v) { return (v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%'; }
  function dataBR(iso) { if (!iso) return '—'; var p = String(iso).slice(0, 10).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function mesBR(m) { var p = String(m).split('-'); return p[1] + '/' + p[0]; }
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
  function lerNumero(txt) {
    if (txt == null) return null;
    var s = String(txt).trim().replace(/\s|R\$/g, '');
    if (!s) return null;
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    var n = Number(s);
    return isFinite(n) ? n : NaN;
  }
  function numParaCampo(v) { return v == null ? '' : String(v).replace('.', ','); }
  function novoId() {
    var b = new Uint8Array(6); window.crypto.getRandomValues(b);
    return 'r' + Date.now().toString(36) + Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  function hojeIso() { return D.hoje ? D.hoje() : new Date().toISOString().slice(0, 10); }
  function botao(texto, fn, rotulo, cls) {
    var b = el('button', { class: 'btn mini' + (cls ? ' ' + cls : ''), type: 'button', 'aria-label': rotulo || null }, texto);
    b.addEventListener('click', fn); return b;
  }
  function status(t) { $('#rd-status').textContent = t || ''; }

  /* ================= estado ================= */
  var E = { dados: null, exemplo: null, ilegivel: false, form: null, visao: 'conf', carteira: null, carteiraRes: null, limites: {}, desfazer: null, desfazerApos: null };
  var NOME = { DIVIDENDO: 'Dividendo', JCP: 'JCP', RENDIMENTO_FII: 'Rendimento de FII', ALUGUEL: 'Aluguel' };
  var SITUACAO = { RECEBIDO: 'Recebido', A_RECEBER: 'A receber', ANUNCIADO: 'Anunciado, sem data' };

  function dataRef() { return E.exemplo && E.exemplo.dataReferencia ? E.exemplo.dataReferencia : hojeIso(); }
  function itens() { return E.exemplo ? E.exemplo.itens : (E.dados ? E.dados.itens : []); }
  function opcoesCarteira(c) { return { manual: c.classes || {}, cadastroOpcoes: c.opcoes || {}, hoje: dataRef() }; }
  /* Posições e bonificações: da carteira real, ou do exemplo quando ele está aberto. */
  function resCarteira() {
    if (E.exemplo) return E.exemplo.res;
    if (!E.carteira) return { posicoes: {}, bonificacoes: [] };
    if (!E.carteiraRes) E.carteiraRes = M.processar(E.carteira.lancamentos, opcoesCarteira(E.carteira));
    return E.carteiraRes;
  }
  function manualAtual() { return E.exemplo ? E.exemplo.classes : (E.carteira && E.carteira.classes) || {}; }

  /* ================= desenho ================= */
  function desenhar() {
    var lista = itens(), tem = lista.length > 0;
    $('#rd-vazio').hidden = tem || E.ilegivel;
    $('#rd-corpo').hidden = !tem;
    var banner = $('#rd-banner'); banner.textContent = ''; banner.hidden = !E.exemplo;
    if (E.exemplo) {
      add(banner, el('strong', null, 'Exemplo — dados fictícios.'), ' Ativos inventados; nada aqui é gravado ou entra no backup. Para lançar os seus dados, saia do exemplo.');
      banner.appendChild(botao('Sair do exemplo', sairExemplo));
    }
    ['#rd-novo-prov', '#rd-novo-alug'].forEach(function (s) { $(s).disabled = !!E.exemplo || E.ilegivel; });
    $('#rd-exemplo').hidden = !!E.exemplo;
    desenharBackup();
    desenharForm();
    if (!tem) return;
    try {
      var bonif = resCarteira().bonificacoes || [];
      var P = M.painelRendimentos(lista, { hoje: dataRef(), bonificacoes: bonif, manual: manualAtual() });
      desenharVisao();
      desenharResumo(P); desenharAlertas(P); desenharMeses(P); desenharProventos(P); desenharAluguel(P); desenharRegras(); desenharEstimados();
    } catch (e) {
      $('#rd-resumo').textContent = '';
      $('#rd-alertas').textContent = '';
      $('#rd-alertas').appendChild(el('p', { class: 'aviso' }, 'Não consegui calcular os rendimentos (' + (e && e.message ? e.message : 'erro') + '). Mande um print para o Claude.'));
    }
  }
  function desenharVisao() {
    var est = E.visao === 'est';
    $('#rd-conf').hidden = est; $('#rd-est').hidden = !est;
    $('#rd-ver-conf').setAttribute('aria-pressed', est ? 'false' : 'true');
    $('#rd-ver-est').setAttribute('aria-pressed', est ? 'true' : 'false');
    $('#rd-ver-conf').className = 'btn' + (est ? '' : ' prim');
    $('#rd-ver-est').className = 'btn' + (est ? ' prim' : '');
  }
  async function desenharBackup() {
    var box = $('#rd-backup');
    if (E.exemplo || !E.dados) { box.hidden = true; return; }
    var ult = null; try { ult = await D.backup.ultimo(); } catch (e) {}
    var a = M.avisoBackup(ult, E.dados.itens, new Date().toISOString());
    box.textContent = '';
    if (!a.mostrar) { box.hidden = true; return; }
    add(box, el('span', null, (a.nunca ? 'Você ainda não fez backup. ' : 'Último backup há ' + a.dias + ' dia(s), com ' + a.depois + ' item(ns) lançados depois dele. ') +
      'Limpar os dados do navegador apaga tudo: exporte um backup e guarde o arquivo fora do computador.'));
    box.appendChild(botao('Fazer backup', function () { document.dispatchEvent(new CustomEvent('cf:abrir-dados')); }));
    box.hidden = false;
  }
  function cartao(rotulo, valor, extra, cls) {
    var d = el('div', { class: 'cart-num' + (cls ? ' ' + cls : '') });
    add(d, el('span', { class: 'v-rotulo' }, rotulo), el('span', { class: 'cart-num-v num' }, valor));
    if (extra) d.appendChild(el('span', { class: 'cart-num-x' }, extra));
    return d;
  }
  function desenharResumo(P) {
    var box = $('#rd-resumo'); box.textContent = '';
    var r = P.resumo, nAl = P.alertas.filter(function (a) { return a.nivel === 'ALERTA'; }).length, nNotas = P.alertas.length - nAl;
    add(box,
      cartao('Recebido em ' + r.ano, r.liquidoAno == null ? '—' : reais(r.liquidoAno), r.faltasAno ? '⚠ falta o IR de ' + r.faltasAno + ' aluguel(éis)' : 'líquido, já pago', r.faltasAno ? 'alerta' : ''),
      cartao('IR retido em ' + r.ano, reais(r.irrfAno), 'na fonte; não entra no DARF'),
      cartao('A receber', reais(r.aReceber), r.nAReceber + ' anúncio(s), líquido; fora do recebido' + (r.faltasAReceber ? ' · ⚠ falta o IR de ' + r.faltasAReceber : '')),
      cartao('Alerta de R$ 50 mil', String(nAl), nAl ? 'veja abaixo' : (nNotas ? nNotas + ' nota(s) abaixo' : 'nenhuma empresa acima do limite'), nAl ? 'alerta' : 'ok'));
  }
  function textoAlerta(a) {
    var soma = reais(a.dividendos) + ' em dividendos' + (a.capitalizacao ? ' + ' + reais(a.capitalizacao) + ' de bonificação (capitalização de lucros)' : '');
    if (a.nivel === 'ALERTA') return a.raiz + ' em ' + mesBR(a.mes) + ': ' + soma + ' = ' + reais(a.total) + ', acima de R$ 50 mil no mês (' + a.ativos.join(', ') + '). A empresa deve reter 10% sobre o total: ' + reais(a.irrf10) +
      '. Lucros até 2025 com distribuição aprovada até 31/12/2025 ficam de fora: confira no aviso da empresa e informe o IR retido no lançamento.' + (a.reembolso ? ' Reembolso de ' + reais(a.reembolso) + ' fora da soma.' : '') + (a.semCusto.length ? ' Bonificação sem custo: ' + a.semCusto.join(', ') + '.' : '');
    if (a.nivel === 'REEMBOLSO') return a.raiz + ' em ' + mesBR(a.mes) + ': ' + soma + ' + ' + reais(a.reembolso) + ' de reembolso de ações alugadas passariam de R$ 50 mil. A Lei 13.043 isenta o reembolso, e a Lei 15.270 não fala dele: o site não soma. Caso para contador.';
    return a.semCusto.join(', ') + ' em ' + mesBR(a.mes) + ': bonificação sem o custo atribuído. O valor pode contar no limite de R$ 50 mil por empresa; informe o custo na aba Carteira para o site somar.';
  }
  function desenharAlertas(P) {
    var box = $('#rd-alertas'); box.textContent = '';
    if (P.pendencias.length || P.alertas.length || P.avisos.length) {
      var ul = el('ul', { class: 'pend-lista' });
      P.alertas.forEach(function (a) {
        var li = el('li', { class: 'pend' + (a.nivel === 'ALERTA' ? '' : ' info') });
        add(li, el('span', { class: 'pend-tipo' }, a.nivel === 'ALERTA' ? 'Acima de R$ 50 mil' : 'Nota'), el('span', { class: 'pend-txt' }, textoAlerta(a)), el('span', { class: 'pend-acoes' }));
        ul.appendChild(li);
      });
      P.pendencias.slice(0, 300).forEach(function (p) {
        var li = el('li', { class: 'pend' }), acoes = el('span', { class: 'pend-acoes' });
        if (!E.exemplo) acoes.appendChild(botao('Corrigir', function () { editar(p.id); }, 'Corrigir o aluguel de ' + p.ativo));
        add(li, el('span', { class: 'pend-tipo' }, 'Falta IR'), el('span', { class: 'pend-txt' }, p.texto), acoes);
        ul.appendChild(li);
      });
      P.avisos.forEach(function (a) {
        var li = el('li', { class: 'pend info' });
        add(li, el('span', { class: 'pend-tipo' }, 'Aviso'), el('span', { class: 'pend-txt' }, a.texto), el('span', { class: 'pend-acoes' }));
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
  }
  function limitar(lista, chave, box, rotulo) {
    var lim = E.limites[chave] || 300;
    if (lista.length <= lim) return lista;
    var p = el('p', { class: 'nota-tab' }, 'Mostrando ' + lim + ' de ' + lista.length + ' ' + rotulo + '. ');
    p.appendChild(botao('Mostrar mais ' + Math.min(300, lista.length - lim), function () { E.limites[chave] = lim + 300; desenhar(); }));
    box.appendChild(p);
    return lista.slice(0, lim);
  }
  function cabecalho(colunas) {
    var tr = el('tr');
    colunas.forEach(function (h) { tr.appendChild(el('th', { scope: 'col', class: h[1] || null }, h[0])); });
    return add(el('thead'), tr);
  }
  function celV(v, faltaTxt) { return el('td', { class: 'v num' + (v == null ? ' ausente' : '') }, v == null ? (faltaTxt || '—') : reais(v)); }
  function desenharMeses(P) {
    var box = $('#rd-meses'); box.textContent = '';
    if (!P.meses.length) { box.appendChild(el('p', { class: 'muted' }, 'Nenhum pagamento recebido até hoje.')); return; }
    var wrap = el('div', { class: 'tabela-wrap' }), t = el('table'), tb = el('tbody'), mais = el('div');
    t.appendChild(cabecalho([['Mês'], ['Dividendos', 'a-dir'], ['JCP', 'a-dir'], ['FII', 'a-dir'], ['Aluguel', 'a-dir'], ['Reembolsos', 'a-dir'], ['Total líquido', 'a-dir'], ['IR retido', 'a-dir']]));
    limitar(P.meses, 'meses', mais, 'meses').forEach(function (m) {
      var r = el('tr');
      r.appendChild(el('td', { class: 'num' }, mesBR(m.mes)));
      ['DIVIDENDO', 'JCP', 'FII', 'ALUGUEL', 'REEMBOLSO'].forEach(function (c) { r.appendChild(m[c] === 0 ? el('td', { class: 'v num muted' }, '—') : celV(m[c], '⚠ falta IR')); });
      var tot = celV(m.total, '⚠ falta IR'); tot.classList.add('forte'); r.appendChild(tot);
      r.appendChild(m.irrf === 0 ? el('td', { class: 'v num muted' }, '—') : celV(m.irrf));
      tb.appendChild(r);
    });
    t.appendChild(tb); wrap.appendChild(t); box.appendChild(wrap); box.appendChild(mais);
    box.appendChild(el('p', { class: 'nota-tab' }, 'Valores líquidos, pelo mês da data de pagamento. Só entra o que já foi pago: anúncios ficam em "A receber". Rendimentos não mudam o preço médio nem o DARF.'));
  }
  function rotuloIR(c) {
    if (c.falta) return '⚠ falta';
    if (c.irrfOrigem === 'SEM') return '—';
    return reais(c.irrf) + (c.irrfOrigem === 'ESTIMADO' ? ' estimado' : ' informado');
  }
  function acoesLinha(i) {
    if (E.exemplo) return el('td');
    var td = el('td', { class: 'acoes-linha' }), rot = NOME[i.tipo] + ' de ' + i.ativo;
    add(td, botao('Editar', function () { editar(i.id); }, 'Editar: ' + rot), botao('Excluir', function () { confirmarExclusao(i); }, 'Excluir: ' + rot));
    return td;
  }
  function desenharProventos(P) {
    var box = $('#rd-prov'); box.textContent = '';
    var lin = P.linhas.filter(function (l) { return l.item.tipo !== 'ALUGUEL'; });
    if (!lin.length) { box.appendChild(el('p', { class: 'muted' }, 'Nenhum provento lançado.')); return; }
    var wrap = el('div', { class: 'tabela-wrap' }), t = el('table'), tb = el('tbody'), mais = el('div');
    t.appendChild(cabecalho([['Pagamento'], ['Ativo'], ['Tipo'], ['Data-com'], ['Qtd.', 'a-dir'], ['Por ação', 'a-dir'], ['Bruto', 'a-dir'], ['IR', 'a-dir'], ['Líquido', 'a-dir'], ['Situação'], ['']]));
    limitar(lin, 'prov', mais, 'proventos').forEach(function (l) {
      var i = l.item, c = l.calc, r = el('tr');
      add(r, el('td', { class: 'num' }, i.pagamento ? dataBR(i.pagamento) : '—'), el('td', null, i.ativo),
        el('td', null, NOME[i.tipo] + (i.origem === 'REEMBOLSO' ? ' · reembolso do aluguel' : '')), el('td', { class: 'num' }, dataBR(i.dataCom)),
        el('td', { class: 'v num' }, qtdBR(i.qtd)), el('td', { class: 'v num' }, porAcao(i.valorUnit)), celV(c.bruto), el('td', { class: 'v num' }, rotuloIR(c)), celV(c.liquido),
        el('td', null, SITUACAO[l.situacao]), acoesLinha(i));
      tb.appendChild(r);
    });
    t.appendChild(tb); wrap.appendChild(t); box.appendChild(wrap); box.appendChild(mais);
  }
  function desenharAluguel(P) {
    var box = $('#rd-alug'); box.textContent = '';
    var lin = P.linhas.filter(function (l) { return l.item.tipo === 'ALUGUEL'; });
    if (!lin.length) { box.appendChild(el('p', { class: 'muted' }, 'Nenhuma remuneração de aluguel lançada. A Rico aluga sozinha: os créditos aparecem no extrato dela e na Área do Investidor da B3.')); return; }
    var wrap = el('div', { class: 'tabela-wrap' }), t = el('table'), tb = el('tbody'), mais = el('div');
    t.appendChild(cabecalho([['Crédito'], ['Ativo'], ['Início do contrato'], ['Prazo', 'a-dir'], ['Bruto', 'a-dir'], ['IR', 'a-dir'], ['Taxa', 'a-dir'], ['Líquido', 'a-dir'], ['Situação'], ['']]));
    limitar(lin, 'alug', mais, 'aluguéis').forEach(function (l) {
      var i = l.item, c = l.calc, r = el('tr');
      add(r, el('td', { class: 'num' }, dataBR(i.pagamento)), el('td', null, i.ativo), el('td', { class: 'num' }, i.inicio ? dataBR(i.inicio) : '—'),
        el('td', { class: 'v num' }, c.prazoDias == null ? '—' : c.prazoDias + ' dias' + (c.aliquota != null ? ' · ' + pctBR(c.aliquota) : '')), celV(c.bruto),
        el('td', { class: 'v num' + (c.falta ? ' ausente' : '') }, rotuloIR(c)), celV(c.custos || null), celV(c.liquido, '⚠ falta IR'), el('td', null, SITUACAO[l.situacao]), acoesLinha(i));
      tb.appendChild(r);
    });
    t.appendChild(tb); wrap.appendChild(t); box.appendChild(wrap); box.appendChild(mais);
    box.appendChild(el('p', { class: 'nota-tab' }, 'A B3 retém o IR na fonte, sobre o valor bruto; não há DARF. As ações alugadas continuam na sua posição e no seu preço médio.'));
  }
  function desenharRegras() {
    var box = $('#rd-regras'); box.textContent = '';
    var ul = el('ul', { class: 'regras' });
    [
      'Dividendos: isentos até R$ 50 mil por mês, por empresa e pessoa física. Acima disso, a empresa retém 10% sobre o total do mês (Lei 9.250/1995, art. 6º-A, redação da Lei 15.270/2025). Lucros até 2025, com distribuição aprovada até 31/12/2025, ficam de fora.',
      'Alerta de R$ 50 mil: soma por raiz do código (PETR3 + PETR4), no mês do pagamento, os dividendos com data de pagamento e a bonificação com custo atribuído, na data ex. A Receita trata a capitalização de lucros como "emprego" (Perguntas e Respostas sobre a Lei 15.270, perguntas 12 e 13). JCP e FII não entram. O alerta não muda o líquido: informe o IR retido no lançamento.',
      'JCP: 17,5% na fonte para pagamentos desde 01/01/2026 e 15% antes (Lei 9.249/1995, art. 9º, § 2º, redação da LC 224/2025). É definitivo. O site estima; o valor do aviso da empresa substitui, inclusive 0. Há leitura de que o aumento só vale desde 01/04/2026: confira no aviso se o pagamento foi de janeiro a março de 2026.',
      'Rendimentos de FII: isentos se o fundo tem 100 cotistas ou mais, cotas só em bolsa ou balcão organizado, e você tem menos de 10% das cotas e dos rendimentos (Lei 11.033/2004, art. 3º).',
      'Aluguel, remuneração do doador: tabela de renda fixa pelo prazo do contrato, 22,5% até 180 dias, 20% até 360, 17,5% até 720 e 15% acima. A B3 retém na fonte, sobre o valor bruto; não há DARF (Lei 13.043/2014, art. 6º). Com o início do contrato, o site estima; o IR do extrato substitui. Sem os dois, o líquido não aparece.',
      'Reembolso de ações alugadas: durante o aluguel, quem paga é o tomador, pela B3, na mesma data e no mesmo valor. Reembolso de dividendo é isento e integral; reembolso de JCP é isento, mas vem líquido do IR que a empresa reteria (Lei 13.043/2014, art. 7º). Fica fora da soma de R$ 50 mil; se fosse decisivo, aparece uma nota: a Lei 15.270 não fala de reembolso.',
      'Situação: com data de pagamento até hoje, recebido; com data futura, a receber; sem data, anunciado. Só o recebido entra nos meses.',
      'Quantidade: o site sugere a posição no fim da data-com, com as ações alugadas incluídas. Se você digitar outra, ele avisa e guarda a sua.',
      'BDR, altas rendas (imposto mínimo acima de R$ 600 mil por ano) e como declarar ficam fora daqui: caso para contador. Cálculo de apoio, não substitui contador. Regras verificadas em ' + dataBR(M.versaoRegras) + ' · motor de carteira v' + M.VERSAO + '.'
    ].forEach(function (t) { ul.appendChild(el('li', null, t)); });
    box.appendChild(ul);
  }
  function desenharEstimados() {
    var box = $('#rd-est-corpo'); box.textContent = '';
    var e = M.estimarProventos(itens(), resCarteira().posicoes, { hoje: dataRef() });
    var res = el('div', { class: 'cart-resumo' });
    add(res, cartao('Estimado em 12 meses', reais(e.liquidoTotal), e.linhas.length + ' pagamento(s), líquido de JCP; não é anúncio', 'estimado'));
    box.appendChild(res);
    if (e.linhas.length) {
      box.appendChild(el('h2', { class: 'secao-t' }, 'Estimado por mês'));
      var w1 = el('div', { class: 'tabela-wrap bloco-estimado' }), t1 = el('table'), b1 = el('tbody');
      t1.appendChild(cabecalho([['Mês'], ['Pagamentos', 'a-dir'], ['Líquido estimado', 'a-dir']]));
      e.meses.forEach(function (m) { add(b1, add(el('tr'), el('td', { class: 'num' }, mesBR(m.mes)), el('td', { class: 'v num' }, String(m.n)), celV(m.liquido))); });
      t1.appendChild(b1); w1.appendChild(t1); box.appendChild(w1);
      box.appendChild(el('h2', { class: 'secao-t' }, 'Base de cada estimativa'));
      var w2 = el('div', { class: 'tabela-wrap bloco-estimado' }), t2 = el('table'), b2 = el('tbody'), mais = el('div');
      t2.appendChild(cabecalho([['Mês'], ['Ativo'], ['Tipo'], ['Qtd. hoje', 'a-dir'], ['Por ação', 'a-dir'], ['Bruto', 'a-dir'], ['Líquido', 'a-dir'], ['Base']]));
      limitar(e.linhas, 'est', mais, 'estimativas').forEach(function (l) {
        var base = 'Pagamento de ' + dataBR(l.base.pagamento) + ', ' + porAcao(l.base.valorUnit) + ' por ação' + (l.anuncioSemData ? '. Há anúncio sem data deste tipo: pode ser o mesmo' : '');
        add(b2, add(el('tr'), el('td', { class: 'num' }, mesBR(l.mes)), el('td', null, l.ativo), el('td', null, NOME[l.tipo]), el('td', { class: 'v num' }, qtdBR(l.qtd)), el('td', { class: 'v num' }, porAcao(l.valorUnit)), celV(l.bruto), celV(l.liquido), el('td', { class: 'rd-base' }, base)));
      });
      t2.appendChild(b2); w2.appendChild(t2); box.appendChild(w2); box.appendChild(mais);
    } else box.appendChild(el('p', { class: 'muted' }, 'Nenhuma estimativa: não há pagamento lançado nos últimos 12 meses de ativos que você tem hoje.'));
    if (e.substituidas) box.appendChild(el('p', { class: 'nota-tab' }, e.substituidas + ' estimativa(s) saíram porque já existe anúncio do mesmo ativo e tipo no mês: ele está em Confirmados.'));
    if (e.semBase.length) box.appendChild(el('p', { class: 'nota-tab' }, 'Sem base (posição hoje, sem pagamento lançado nos últimos 12 meses): ' + e.semBase.join(', ') + '.'));
    if (e.semPosicao.length) box.appendChild(el('p', { class: 'nota-tab' }, 'Sem posição hoje, fora da estimativa: ' + e.semPosicao.join(', ') + '.'));
    box.appendChild(el('p', { class: 'nota-tab' }, 'Como estima: cada pagamento dos últimos 12 meses se repete no mesmo mês do ano seguinte, com o valor por ação da época e a posição de hoje. Empresa pode pagar menos, mais ou nada; desdobramento depois do pagamento distorce o valor por ação; o limite de R$ 50 mil não é aplicado. Nunca se soma aos confirmados.'));
  }

  /* ================= formulário ================= */
  function campo(id, rotulo, valor, attrs, dica) {
    var d = el('div', { class: 'campo' });
    d.appendChild(el('label', { for: id }, rotulo));
    var i = el('input', Object.assign({ id: id, type: 'text', autocomplete: 'off' }, attrs || {}));
    i.value = valor == null ? '' : valor;
    d.appendChild(i);
    if (dica) d.appendChild(el('span', { class: 'dica', id: id + '-dica' }, dica));
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
  function abrirForm(tipo, id, pre) { E.form = { tipo: tipo, id: id || null, pre: pre || {} }; desenharForm(); var f = $('#rd-form input, #rd-form select'); if (f) f.focus(); }
  function fecharForm() { E.form = null; desenharForm(); }
  function acharItem(id) { return E.dados ? E.dados.itens.filter(function (x) { return x.id === id; })[0] || null : null; }
  function editar(id) { var i = acharItem(id); if (!i) return; abrirForm(i.tipo === 'ALUGUEL' ? 'ALUGUEL' : 'PROVENTO', id, i); $('#rd-form').scrollIntoView({ block: 'start' }); }
  function erroForm(t, foco) { var m = $('#rf-msg'); if (m) m.textContent = t; if (foco && document.getElementById(foco)) document.getElementById(foco).focus(); }
  function normTicker(t) { return M.normalizarTicker(t); }
  function posicaoDaData(ativo, data) {
    if (!E.carteira || !ativo || !/^\d{4}-\d\d-\d\d$/.test(data || '')) return null;
    return M.posicaoEm(E.carteira.lancamentos, ativo, data, opcoesCarteira(E.carteira));
  }
  function sugerirQuantidade() {
    var a = normTicker($('#rf-ativo').value), dc = $('#rf-com').value, dica = $('#rf-qtd-dica');
    if (!a || !dc || !dica) return;
    var q = posicaoDaData(a, dc);
    if (q == null) { dica.textContent = 'Carteira indisponível: digite a quantidade.'; return; }
    dica.textContent = 'Posição no fim de ' + dataBR(dc) + ': ' + qtdBR(q) + (q ? '. Sugestão: confira no aviso ou no extrato.' : '. Sem posição nesta data, pela carteira.');
    if (q > 0 && !$('#rf-qtd').value.trim()) $('#rf-qtd').value = String(q);
  }
  function desenharForm() {
    var box = $('#rd-form'); box.textContent = '';
    var f = E.form; box.hidden = !f || !!E.exemplo;
    if (!f || E.exemplo) return;
    var p = f.pre, cab = el('div', { class: 'cab-cenario' });
    cab.appendChild(el('h2', null, (f.id ? 'Editar: ' : '') + (f.tipo === 'ALUGUEL' ? 'Aluguel de ações' : 'Provento')));
    box.appendChild(cab);
    var campos = el('div', { class: 'campos' }), explica;
    if (f.tipo === 'PROVENTO') {
      add(campos,
        campoSel('rf-tipo', 'Tipo', [['DIVIDENDO', 'Dividendo'], ['JCP', 'JCP'], ['RENDIMENTO_FII', 'Rendimento de FII']], p.tipo || 'DIVIDENDO'),
        campoSel('rf-origem', 'Como você recebe', [['COMPANHIA', 'Direto da empresa'], ['REEMBOLSO', 'Reembolso do aluguel (ações alugadas na data)']], p.origem || 'COMPANHIA'),
        campo('rf-ativo', 'Ativo (código)', p.ativo || '', { placeholder: 'ex.: PETR4', maxlength: '12', autocapitalize: 'characters' }),
        campo('rf-com', 'Data-com', p.dataCom || '', { type: 'date' }, 'Último dia com direito ao provento.'),
        campo('rf-pag', 'Data de pagamento', p.pagamento || '', { type: 'date' }, 'Vazia = anunciado, sem data.'),
        campo('rf-qtd', 'Quantidade', p.qtd != null ? String(p.qtd) : '', { inputmode: 'numeric', placeholder: 'ex.: 100' }, 'O site sugere a posição da data-com.'),
        campo('rf-unit', 'Valor bruto por ação (R$)', numParaCampo(p.valorUnit), { inputmode: 'decimal', placeholder: 'ex.: 0,4325' }, 'O do aviso aos acionistas.'),
        campo('rf-ir', 'IR retido (R$, opcional)', numParaCampo(p.irrf), { inputmode: 'decimal', placeholder: 'vazio = regra do site' }, 'Em JCP, vazio = estima. O valor do aviso substitui.'),
        campo('rf-fonte', 'Fonte (opcional)', p.fonte || '', { maxlength: '80', placeholder: 'ex.: aviso aos acionistas de 10/03' }));
      explica = 'Só valores anunciados pela empresa, ou já pagos. Estimativa não entra aqui: fica em "Estimados".';
    } else {
      add(campos,
        campo('rf-ativo', 'Ativo (código)', p.ativo || '', { placeholder: 'ex.: PETR4', maxlength: '12', autocapitalize: 'characters' }),
        campo('rf-pag', 'Data do crédito', p.pagamento || '', { type: 'date' }),
        campo('rf-ini', 'Início do contrato (opcional)', p.inicio || '', { type: 'date' }, 'Com ele, o site estima o IR pelo prazo.'),
        campo('rf-bruto', 'Remuneração bruta (R$)', numParaCampo(p.bruto), { inputmode: 'decimal', placeholder: 'ex.: 42,80' }),
        campo('rf-ir', 'IR retido (R$, opcional)', numParaCampo(p.irrf), { inputmode: 'decimal', placeholder: 'o do extrato' }, 'O valor do extrato substitui a estimativa.'),
        campo('rf-custos', 'Taxa da corretora (R$, opcional)', numParaCampo(p.custos), { inputmode: 'decimal', placeholder: 'se houver' }, 'Sai do líquido; não reduz a base do IR.'),
        campo('rf-fonte', 'Fonte (opcional)', p.fonte || '', { maxlength: '80', placeholder: 'ex.: extrato da Rico' }));
      explica = 'Lance a remuneração de cada contrato. O reembolso de dividendo ou JCP das ações alugadas entra em "+ Provento", com "Reembolso do aluguel".';
    }
    box.appendChild(campos);
    box.appendChild(el('p', { class: 'explica' }, explica));
    box.appendChild(el('p', { class: 'msg', id: 'rf-msg', role: 'status' }));
    var ac = el('div', { class: 'acoes' });
    var ok = el('button', { class: 'btn prim', type: 'button' }, 'Salvar lançamento'); ok.addEventListener('click', salvarForm);
    var no = el('button', { class: 'btn', type: 'button' }, 'Cancelar'); no.addEventListener('click', fecharForm);
    add(ac, ok, no); box.appendChild(ac);
    if (f.tipo === 'PROVENTO') {
      $('#rf-ativo').addEventListener('blur', sugerirQuantidade);
      $('#rf-com').addEventListener('change', sugerirQuantidade);
    }
  }
  function numOpcional(id, rotulo) {
    var n = lerNumero($('#' + id).value);
    if (n !== n) { erroForm('Valor inválido em ' + rotulo + ': use números, como 12,50.', id); return false; }
    return n;
  }
  async function salvarForm() {
    var f = E.form; if (!f) return;
    var i = { id: f.id || novoId(), ativo: normTicker($('#rf-ativo').value) };
    var irrf = numOpcional('rf-ir', 'IR retido'); if (irrf === false) return;
    var pag = $('#rf-pag').value || null, fonte = $('#rf-fonte').value.trim();
    if (!i.ativo) { erroForm('Informe o código do ativo (ex.: PETR4).', 'rf-ativo'); return; }
    if (pag) i.pagamento = pag;
    if (irrf != null) i.irrf = irrf;
    if (fonte) i.fonte = fonte;
    if (f.tipo === 'PROVENTO') {
      i.tipo = $('#rf-tipo').value; i.origem = $('#rf-origem').value; i.dataCom = $('#rf-com').value;
      var q = lerNumero($('#rf-qtd').value), u = numOpcional('rf-unit', 'valor por ação'); if (u === false) return;
      if (!i.dataCom) { erroForm('Informe a data-com: ela está no aviso aos acionistas.', 'rf-com'); return; }
      if (u == null) { erroForm('Informe o valor bruto por ação.', 'rf-unit'); return; }
      i.qtd = q; i.valorUnit = u;
    } else {
      i.tipo = 'ALUGUEL';
      var ini = $('#rf-ini').value || null, b = numOpcional('rf-bruto', 'remuneração bruta'), cu = numOpcional('rf-custos', 'taxa da corretora');
      if (b === false || cu === false) return;
      if (!pag) { erroForm('Informe a data do crédito.', 'rf-pag'); return; }
      if (b == null) { erroForm('Informe a remuneração bruta.', 'rf-bruto'); return; }
      if (ini) i.inicio = ini;
      i.bruto = b; if (cu != null) i.custos = cu;
    }
    var agora = new Date().toISOString(), velho = f.id ? acharItem(f.id) : null;
    i.criadoEm = velho && velho.criadoEm ? velho.criadoEm : agora;
    if (velho) i.atualizadoEm = agora;
    var erro = D.validarItemProvento(i);
    if (erro) { erroForm('Não salvei: ' + erro + '.'); return; }
    var d = copia();
    if (f.id) d.itens = d.itens.map(function (x) { return x.id === f.id ? i : x; }); else d.itens.push(i);
    if (await gravar(d)) {
      var c = M.calcularRendimento(i), msg = 'Lançamento salvo: ' + NOME[i.tipo].toLowerCase() + ' de ' + i.ativo + '.';
      if (c.falta) msg += ' Falta o IR retido: sem ele, o líquido não aparece.';
      if (i.tipo !== 'ALUGUEL') { var qp = posicaoDaData(i.ativo, i.dataCom); if (qp != null && qp !== i.qtd) msg += ' Atenção: a carteira tinha ' + qtdBR(qp) + ' no fim de ' + dataBR(i.dataCom) + '; ficou a quantidade que você digitou.'; }
      E.form = null; E.desfazer = null; desenhar(); status(msg);
    }
  }
  function copia() { return JSON.parse(JSON.stringify(E.dados || { versao: 1, itens: [] })); }
  async function gravar(d) {
    if (E.exemplo) { status('No exemplo nada é gravado.'); return false; }
    try { await D.gravar('proventos', d); E.dados = d; return true; }
    catch (e) { var t = 'Não salvei (' + e.message + ').', m = $('#rf-msg'); if (m && E.form) m.textContent = t; else status(t); return false; }
  }
  function confirmarExclusao(i) {
    var conf = $('#rd-status'), box = el('span', { class: 'conf-inline' });
    add(box, 'Excluir ' + NOME[i.tipo].toLowerCase() + ' de ' + i.ativo + '? ');
    var sim = botao('Excluir', async function () {
      var antes = copia(), d = copia();
      d.itens = d.itens.filter(function (x) { return x.id !== i.id; });
      if (await gravar(d)) {
        E.desfazer = antes; E.desfazerApos = JSON.stringify(E.dados); desenhar();
        conf.textContent = 'Lançamento excluído. ';
        conf.appendChild(botao('Desfazer', async function () {
          if (!E.desfazer) return;
          if (JSON.stringify(E.dados) !== E.desfazerApos) { E.desfazer = null; status('Não desfiz: os dados mudaram depois da exclusão.'); return; }
          var a = E.desfazer; E.desfazer = null;
          if (await gravar(a)) { desenhar(); status('Exclusão desfeita.'); }
        }));
      }
    }, null, 'perigo');
    var nao = botao('Cancelar', function () { status(''); });
    add(box, sim, nao); conf.textContent = ''; conf.appendChild(box); sim.focus();
  }

  /* ================= exemplo (dados fictícios, só na memória) ================= */
  async function carregarExemplo() {
    try {
      var ex = await D.carteiraExemplo();
      var ref = /^\d{4}-\d\d-\d\d$/.test(ex.dataReferencia || '') ? ex.dataReferencia : null;
      E.exemplo = { itens: Array.isArray(ex.proventos) ? ex.proventos : [], classes: ex.classes || {}, dataReferencia: ref };
      E.exemplo.res = M.processar(ex.lancamentos, { manual: ex.classes || {}, cadastroOpcoes: ex.opcoes || {}, hoje: ref });
      E.form = null; E.limites = {}; status(''); desenhar();
    } catch (e) { status('Não consegui abrir o exemplo (' + e.message + ').'); }
  }
  function sairExemplo() { E.exemplo = null; E.limites = {}; E.visao = 'conf'; status(''); desenhar(); }

  /* ================= início ================= */
  async function carregar() {
    try { var d = await D.ler('proventos'); E.dados = d || { versao: 1, itens: [] }; E.ilegivel = false; }
    catch (e) {
      E.dados = null; E.ilegivel = true;
      status('Os rendimentos guardados neste navegador não puderam ser lidos (veja o aviso no topo). Nada será gravado por cima.');
    }
    desenhar();
  }
  $('#rd-novo-prov').addEventListener('click', function () { abrirForm('PROVENTO'); });
  $('#rd-novo-alug').addEventListener('click', function () { abrirForm('ALUGUEL'); });
  $('#rd-vazio-prov').addEventListener('click', function () { abrirForm('PROVENTO'); });
  $('#rd-exemplo').addEventListener('click', carregarExemplo);
  $('#rd-vazio-exemplo').addEventListener('click', carregarExemplo);
  $('#rd-ver-conf').addEventListener('click', function () { E.visao = 'conf'; desenharVisao(); });
  $('#rd-ver-est').addEventListener('click', function () { E.visao = 'est'; desenharVisao(); });
  document.addEventListener('cf:carteira', function (ev) {
    E.carteira = ev.detail && ev.detail.carteira ? ev.detail.carteira : null; E.carteiraRes = null;
    if (!E.exemplo && E.dados) desenhar();
  });
  document.addEventListener('cf:dados-restaurados', function () { E.desfazer = null; E.form = null; status(''); carregar(); });
  document.addEventListener('cf:backup-exportado', function () { if (!E.exemplo) desenharBackup(); });
  carregar();
  document.dispatchEvent(new CustomEvent('cf:pedir-carteira'));
})();
