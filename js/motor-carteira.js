/*
 * Motor de carteira de renda variável BR — posição, preço médio, resultado realizado, pendências e IR mensal.
 * Funções puras, sem dependências. Navegador (window.MotorCarteira) e Node (require).
 * v2.0.0 (31/10/2026, F3 Passo A); v2.0.1 (01/11/2026): evento com quantidade resultante fora da faixa vira pendência (6ª revisão);
 * v2.0.2 (01/11/2026): tickers terminados em 11 classificados à mão (decisão 36; a lista da B3 saiu do site);
 * v2.1.0 (01/11/2026, F3 Passo B): opções — exercício parcial, cadastro da opção (ativo-objeto, tipo, strike, vencimento),
 *   vencimento pendente, cobertura de calls, caixa das puts, campanhas (custo gerencial × fiscal), vencimento sugerido,
 *   raiz de ticker com número (B3SA3) e séries semanais (…W1). Casos O1–O31 em claude/f3-casos-opcoes.md. 7ª revisão:
 *   corretora como chave sem protótipo, agrupamento do dia e campanhas em tempo linear, aviso de tipo de exercício divergente.
 * v2.2.0 (03/11/2026, F3.2): exercício que entrega ações entra antes dos negócios do dia; venda no mesmo dia apura contra o lote
 *   do exercício (P&R 725/726; IN 1.585, art. 60), 15%, sem isenção, sem day trade (art. 65, § 13); campanha mostra o que aguarda
 *   lançamento. Casos O32–O52.
 * v2.3.0 (03/11/2026, F4): IRRF estimado (0,005% e 1%) ou da nota, saldo de IRRF por categoria até dezembro, mês que depende de
 *   mês incompleto, imposto arredondado por categoria, vencimento pela lista de feriados, painel do DARF e "já paguei". Casos IR1–IR27.
 * v2.4.1 (03/11/2026, revisão independente): preço médio desconhecido bloqueia também venda de opção, vencimento e exercício; grafia da corretora não separa day trade nem a soma do IRRF; soma do DARF acumulado arredondada.
 * v2.4.0 (03/11/2026, F5): proventos confirmados, aluguel (doador), rendimentos por mês e por tipo, alerta de R$ 50 mil por empresa,
 *   proventos estimados pelo histórico e posição na data-com. Casos R1–R27 em claude/f5-casos-rendimentos.md.
 * Regras verificadas em 03/11/2026 — ver references/regras-ir-renda-variavel.md
 * da skill carteira-acoes-ir-br. Onde este cabeçalho resume uma regra, a skill prevalece.
 *
 * Lançamentos (entrada de processar):
 *  Saldo inicial  { id, tipo:'SALDO', data, ativo, qtd, pm }            posição no INÍCIO do dia (pm já com custos)
 *  Negócio        { id, data, ativo, lado:'C'|'V', qtd, preco, custos, corretora, seq, irrf?, irrfDT?, classe? }
 *                 custos = taxas da nota que cabem a este negócio (corretagem + emolumentos + liquidação),
 *                 já rateados pelo valor financeiro (IN RFB 1.585/2015, art. 56, § 4º). Obrigatório (0 de propósito).
 *  Eventos (data = primeiro dia "ex"; aplicados ANTES dos negócios do dia):
 *    { tipo:'DESDOBRAMENTO'|'GRUPAMENTO', ativo, de, para }            ex.: desdobramento 1 para 2; grupamento 10 para 1
 *    { tipo:'BONIFICACAO', ativo, de, para, custoUnit }                para cada `de` ações recebe `para`; custo atribuído
 *                                                                      pela empresa (IN 1.585, art. 58, § 1º); ausente = pendência
 *    { tipo:'DIREITO_RECEBIDO', ativo:<ticker do direito>, qtd }       custo zero (inerente à condição de acionista)
 *    { tipo:'SUBSCRICAO', ativo, qtd, preco, direito? }                ações subscritas; consome 1 direito por ação, se houver
 *    { tipo:'EXPIRACAO', ativo:<ticker do direito> }                   direito não exercido nem vendido
 *    { tipo:'INCORPORACAO', ativo, novoAtivo, proporcao }              novas ações por ação antiga; custo transferido + aviso
 *    { tipo:'LEILAO_FRACAO', ativo, valor }                            valor creditado pelo leilão da fração
 *  Eventos de opção. Exercício que ENTREGA ações (titular de call, lançador de put): antes dos negócios do dia, depois dos negócios
 *    da própria opção, porque a direção depende da posição resultante. Vencimento e exercício que RETIRA ações: depois dos negócios.
 *    { tipo:'VENCIMENTO', ativo }  { tipo:'EXERCICIO', ativo, subjacente, classeSub?, tipoOpcao:'CALL'|'PUT', strike, custos?, qtd? }
 *    qtd ausente = exercício de toda a posição; qtd menor = exercício parcial; qtd maior que a posição = pendência.
 *  Cadastro das opções (opcoes.cadastroOpcoes, gerencial): { TICKER: { subjacente, tipo:'CALL'|'PUT', strike, vencimento } }.
 *    Usado para a cobertura, o caixa das puts, as campanhas e o aviso de vencimento passado (opcoes.hoje = 'AAAA-MM-DD').
 *  Campanha (premissa P1): começa quando surge ação ou opção do ativo-objeto e fecha quando não sobra nenhuma.
 *    Custo gerencial (premissa P2) = custo fiscal − resultado realizado das opções do ativo na campanha.
 *
 * Ordem: data; no mesmo dia, saldo → eventos societários → exercício que entrega ações → negócios (pela `seq`, a ordem de
 *   lançamento) → vencimento e exercício que retira ações.
 * Lote do exercício: as ações entregues ficam num lote do dia, fora do preço médio. A sobra de venda do dia (depois do day trade)
 *   consome o lote primeiro: resultado = venda − custo do lote (strike ± prêmio + custos), não isento, sem pareamento de day trade.
 *   Vários exercícios no dia: custo médio dos lotes. O que sobra do lote entra no preço médio depois dos negócios do dia.
 * Day trade: mesmo ativo, mesmo dia, mesma corretora. Pareamento em sequência: primeiro negócio de compra com o primeiro
 *   de venda, ou o primeiro de venda com o primeiro de compra (P&R IRPF da Receita). Day trade não mexe no preço médio.
 *   O que sobra (só de um lado) é operação comum e entra na posição na ordem dos negócios.
 * Venda maior que a posição (exceto opção): posição vai a zero, a operação NÃO é calculada e vira pendência; o mês
 *   fica incompleto. Opção vendida sem posição é lançamento (posição vendida), permitido.
 *
 * Classes: ACAO, UNIT (tratada como ação, inclusive na isenção: premissa declarada), ETF, BDR, FII, FIAGRO (regras do FII:
 *   premissa), OPCAO, DIREITO (venda nunca isenta: SC COSIT 166/2021), FIINFRA e ETF_RF (regra própria: fora do cálculo).
 *   Tickers terminados em 11 (unit, ETF, FII, Fiagro…) são classificados pelo usuário, uma vez por ativo (decisão 36); sem isso,
 *   pendência. `listaB3` continua aceito (lista { TICKER: CLASSE } fornecida por quem chama), mas o site passa lista vazia.
 *
 * Config: { volumeForaIsencaoContaNoLimite:true, prejuizoMesIsentoCompensa:true } (ver skill).
 *
 * IRRF (opcoes.estimarIrrf = true; opcoes.irrfInformado = { 'AAAA-MM': { COMUM, DAYTRADE, FII } } = valor da nota, que substitui a estimativa):
 *   0,005% sobre as vendas à vista e sobre o saldo positivo dos prêmios de cada dia (IN 1.585, art. 63, IV e § 8º), fora o day trade; por corretora,
 *   somando o mês, sem retenção quando a soma dá até R$ 1,00 (P&R 706). Venda por exercício fora da base (premissa conservadora; a nota corrige).
 *   1% sobre o resultado positivo do day trade do dia, por corretora (art. 65, § 1º, II). Sem a opção, só o `irrf`/`irrfDT` do negócio conta.
 *   Saldo não usado: nos meses seguintes, por categoria, até dezembro do mesmo ano; o que sobra vai para a declaração (art. 63, § 8º; art. 65, § 8º; P&R 714 e 715).
 */
(function (root) {
  'use strict';

  var VERSAO = '2.4.1';
  var CAT = { COMUM: 'COMUM', DT: 'DAYTRADE', FII: 'FII', FORA: 'FORA' };
  var ALIQ = { COMUM: 0.15, DAYTRADE: 0.20, FII: 0.20 };
  var LIMITE_ISENCAO = 20000;
  var DARF_MINIMO = 10;
  var CLASSES = ['ACAO', 'UNIT', 'ETF', 'BDR', 'FII', 'FIAGRO', 'OPCAO', 'DIREITO', 'FIINFRA', 'ETF_RF'];
  var NOME_CLASSE = { ACAO: 'Ação', UNIT: 'Unit', ETF: 'ETF de ações', BDR: 'BDR', FII: 'FII', FIAGRO: 'Fiagro', OPCAO: 'Opção',
    DIREITO: 'Direito de subscrição', FIINFRA: 'FI-Infra', ETF_RF: 'ETF de renda fixa' };
  var EVENTOS_SOC = ['DESDOBRAMENTO', 'GRUPAMENTO', 'BONIFICACAO', 'DIREITO_RECEBIDO', 'SUBSCRICAO', 'EXPIRACAO', 'INCORPORACAO', 'LEILAO_FRACAO'];
  var EVENTOS_OPCAO = ['VENCIMENTO', 'EXERCICIO'];
  var EPS = 1e-9;

  function mes(d) { return String(d).slice(0, 7); }
  function r2(x) { return x == null ? null : Math.round((x + (x >= 0 ? EPS : -EPS)) * 100) / 100; }
  function ehAcaoIsenta(classe) { return classe === 'ACAO' || classe === 'UNIT'; }

  /* ---------- classificação ---------- */
  function normalizarTicker(t) {
    t = String(t == null ? '' : t).trim().toUpperCase();
    if (/^[A-Z][A-Z0-9]{3}\d{1,2}F$/.test(t)) t = t.slice(0, -1);   // fracionário: PETR4F → PETR4, B3SA3F → B3SA3
    return t;
  }
  /**
   * Classe de um ativo. listaB3 = { TICKER: CLASSE } (opcional; o site passa vazia); manual = { TICKER: CLASSE } (escolha do usuário).
   * Devolve { classe, origem:'manual'|'b3'|'codigo'|null, tipoOpcao? }. classe null = pendência de classificação.
   */
  function classificar(ticker, listaB3, manual) {
    var t = normalizarTicker(ticker);
    if (manual && Object.prototype.hasOwnProperty.call(manual, t) && CLASSES.indexOf(manual[t]) >= 0) return { classe: manual[t], origem: 'manual' };
    // Raiz de 4 caracteres começando por letra (B3SA tem número). Opção: raiz + letra do tipo/mês (A–L call, M–X put)
    // + série de 1 a 3 caracteres + Wn nas semanais (B3, "Opções Semanais sobre Ações": AAAABCCCWn).
    if (/^[A-Z][A-Z0-9]{3}11$/.test(t)) {
      var b = listaB3 && Object.prototype.hasOwnProperty.call(listaB3, t) ? listaB3[t] : null;
      return CLASSES.indexOf(b) >= 0 ? { classe: b, origem: 'b3' } : { classe: null, origem: null };
    }
    if (/^[A-Z][A-Z0-9]{3}[3-8]$/.test(t)) return { classe: 'ACAO', origem: 'codigo' };
    if (/^[A-Z][A-Z0-9]{3}(3[1-5]|39)$/.test(t)) return { classe: 'BDR', origem: 'codigo' };
    if (/^[A-Z][A-Z0-9]{3}[12]$/.test(t)) return { classe: 'DIREITO', origem: 'codigo' };
    var o = /^[A-Z][A-Z0-9]{3}([A-X])\d{1,3}[A-Z0-9]?(W[1-5])?$/.exec(t);
    if (o) return { classe: 'OPCAO', origem: 'codigo', tipoOpcao: o[1] <= 'L' ? 'CALL' : 'PUT' };
    return { classe: null, origem: null };
  }

  function categoria(classe, dayTrade) {
    if (classe === 'FIINFRA' || classe === 'ETF_RF') return CAT.FORA;
    if (classe === 'FII' || classe === 'FIAGRO') return CAT.FII;   // 20% em swing e day trade, compensação própria
    if (!classe) return null;
    return dayTrade ? CAT.DT : CAT.COMUM;
  }

  // Mesma instituição, mesma chave: maiúsculas, acentos e espaços digitados diferente não separam o day trade nem a soma do IRRF.
  function chaveCorretora(c) { return String(c || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase(); }
  function novaPosicao(ativo, classe) { return { ativo: ativo, classe: classe, qtd: 0, pm: 0, pmDesconhecido: false, fracao: null }; }

  /**
   * Aplica uma quantidade (positiva = compra, negativa = venda) à posição pelo preço médio.
   * Retorna o resultado realizado da parte que reduziu a posição. precoLiq: preço unitário com custos.
   */
  function movimentar(pos, qtd, precoLiq) {
    if (pos.qtd === 0 || Math.sign(pos.qtd) === Math.sign(qtd)) {
      var novaQtd = pos.qtd + qtd;
      pos.pm = (Math.abs(pos.qtd) * pos.pm + Math.abs(qtd) * precoLiq) / Math.abs(novaQtd);
      pos.qtd = novaQtd;
      return 0;
    }
    var fecha = Math.min(Math.abs(qtd), Math.abs(pos.qtd));
    var res = pos.qtd > 0 ? (precoLiq - pos.pm) * fecha : (pos.pm - precoLiq) * fecha;
    var sobra = Math.abs(qtd) - fecha;
    pos.qtd += Math.sign(qtd) * fecha;
    if (pos.qtd === 0) { pos.pm = 0; pos.pmDesconhecido = false; }
    if (sobra > 0) { pos.qtd = Math.sign(qtd) * sobra; pos.pm = precoLiq; }   // inverte a posição (só opção)
    return res;
  }

  function ordemFase(l) {
    if (l.tipo === 'SALDO') return 0;
    if (EVENTOS_SOC.indexOf(l.tipo) >= 0) return 1;
    if (EVENTOS_OPCAO.indexOf(l.tipo) >= 0) return 3;
    return 2;
  }

  /**
   * Processa lançamentos e eventos. opcoes: { listaB3, manual, config }.
   * Retorna { posicoes, extrato, pendencias, avisos, vendasAcoesMes, vendasForaIsencaoMes, irrfMes, apuracao, mesesIncompletos }.
   */
  function processar(entradas, opcoes) {
    opcoes = opcoes || {};
    // compatibilidade: processar(entradas, config) da v1
    var config = opcoes.config || (opcoes.listaB3 || opcoes.manual || opcoes.cadastroOpcoes || opcoes.hoje || opcoes.estimarIrrf || opcoes.irrfInformado ? {} : opcoes);
    config = Object.assign({ volumeForaIsencaoContaNoLimite: true, prejuizoMesIsentoCompensa: true }, config || {});
    var listaB3 = opcoes.listaB3 || null, manual = opcoes.manual || null;
    var cadastro = opcoes.cadastroOpcoes || {}, hoje = typeof opcoes.hoje === 'string' ? opcoes.hoje : null;
    function cad(t) { return Object.prototype.hasOwnProperty.call(cadastro, t) ? cadastro[t] : null; }

    var ops = (entradas || []).map(function (l, i) { return { l: l, i: i }; });
    ops.sort(function (a, b) {
      if (a.l.data !== b.l.data) return a.l.data < b.l.data ? -1 : 1;
      var fa = ordemFase(a.l), fb = ordemFase(b.l); if (fa !== fb) return fa - fb;
      var sa = a.l.seq != null ? a.l.seq : a.i, sb = b.l.seq != null ? b.l.seq : b.i;
      return sa - sb || a.i - b.i;
    });

    var pos = {}, extrato = [], pendencias = [], avisos = [], bonificacoes = [], vendas = {}, vendasFora = {}, irrf = {}, incompletos = {};
    var classeDe = {};
    var ordemAtual = 0, marcos = [], exercicios = [], subDeExercicio = {};
    var baseFonte = Object.create(null), premiosDia = Object.create(null), dtDia = Object.create(null);   // bases do IRRF estimado
    function somarBase(m, corretora, cat, v) {
      if (cat !== CAT.COMUM && cat !== CAT.FII) return;
      var b = baseFonte[m] || (baseFonte[m] = Object.create(null)), c = b[corretora] || (b[corretora] = { COMUM: 0, FII: 0 });
      c[cat] += v;
    }
    var loteDia = Object.create(null), diaLote = null, entregandoNoDia = false;   // lote do exercício que entrega ações, à espera das vendas do dia
    function marcar(data) {
      for (var k = 1; k < arguments.length; k++) {
        var a = arguments[k] ? normalizarTicker(arguments[k]) : null;
        if (a && pos[a]) marcos.push({ ordem: ordemAtual, data: data, ativo: a, qtd: pos[a].qtd + (loteDia[a] ? loteDia[a].qtd : 0) });
      }
    }

    function classeAtivo(ativo, dada) {
      if (dada) { classeDe[ativo] = dada; return dada; }
      if (Object.prototype.hasOwnProperty.call(classeDe, ativo)) return classeDe[ativo];
      var c = classificar(ativo, listaB3, manual);
      classeDe[ativo] = c.classe;
      if (!c.classe) pendencias.push({ tipo: 'CLASSIFICAR', ativo: ativo, texto: ativo + ': escolha a classe do ativo (unit, ETF, FII, Fiagro…). Códigos terminados em 11 não dizem a classe sozinhos; a escolha vale para todos os lançamentos do ativo.' });
      return c.classe;
    }
    function P(ativo, classe) { var a = normalizarTicker(ativo); return pos[a] || (pos[a] = novaPosicao(a, classeAtivo(a, classe))); }
    function addVenda(m, v) { vendas[m] = (vendas[m] || 0) + v; }
    function addFora(m, v) { vendasFora[m] = (vendasFora[m] || 0) + v; }
    function addIrrf(m, c, v) { if (!c || c === CAT.FORA) return; irrf[m] = irrf[m] || {}; irrf[m][c] = (irrf[m][c] || 0) + (v || 0); }
    function incompleto(m, motivo) { (incompletos[m] = incompletos[m] || []).push(motivo); }
    function pend(p) { pendencias.push(p); if (p.data && p.bloqueiaMes) incompleto(mes(p.data), p.texto); }
    function pmSemValor(id, ativo, data, oQue) {
      pend({ tipo: 'PM_DESCONHECIDO', id: id, ativo: ativo, data: data, bloqueiaMes: true,
        texto: ativo + ' em ' + data + ': ' + oQue + ' sem custo conhecido (falta o preço médio do saldo inicial ou o custo de bonificação). A operação não foi calculada.' });
    }
    function registrar(l, ativo, classe, cat, valor, desc, naoIsenta) {
      var x = { data: l.data, mes: mes(l.data), ativo: ativo, classe: classe, categoria: cat, resultado: r2(valor),
        descricao: desc, naoIsenta: !!naoIsenta, id: l.id || null, ordem: ordemAtual };
      extrato.push(x);
      if (valor == null) incompleto(x.mes, ativo + ': resultado não calculado (' + desc + ')');
      else if (!cat) incompleto(x.mes, ativo + ': ativo sem classe');
      return x;
    }

    // Agrupa os negócios por dia + ativo (todas as corretoras), para parear o day trade por corretora
    // e aplicar as sobras na ordem dos negócios. O grupo é aplicado na posição do primeiro negócio do ativo no dia.
    // Índice montado numa passada (v2.1.0, 7ª revisão: a busca dentro do dia era quadrática).
    var gruposDia = {}, feitos = {}, liquidoDia = Object.create(null), exerciciosDia = Object.create(null), antecipado = {}, diaAntecipado = null;
    ops.forEach(function (o, idx) {
      if (!o.l.tipo) {
        var k = o.l.data + '|' + normalizarTicker(o.l.ativo);
        (gruposDia[k] = gruposDia[k] || []).push(o.l);
        liquidoDia[k] = (liquidoDia[k] || 0) + (o.l.lado === 'C' ? o.l.qtd : -o.l.qtd);
      } else if (o.l.tipo === 'EXERCICIO') (exerciciosDia[o.l.data] = exerciciosDia[o.l.data] || []).push(idx);
    });
    for (var i = 0; i < ops.length; i++) {
      var l = ops[i].l, fase = ordemFase(l);
      ordemAtual++;
      if (diaLote !== null && l.data !== diaLote) fecharLotes();
      if (fase >= 2 && l.data !== diaAntecipado) { diaAntecipado = l.data; anteciparExercicios(l.data); }
      if (diaLote !== null && fase === 3) fecharLotes();
      if (antecipado[i]) continue;
      if (l.tipo === 'SALDO') { aplicarSaldo(l); marcar(l.data, l.ativo); continue; }
      if (l.tipo) { aplicarEvento(l); marcar(l.data, l.ativo, l.subjacente, l.novoAtivo, l.direito); continue; }
      var ativo = normalizarTicker(l.ativo), chave = l.data + '|' + ativo;
      if (feitos[chave]) continue;
      feitos[chave] = true;
      aplicarDia(ativo, gruposDia[chave]);
      marcar(l.data, ativo);
    }
    fecharLotes();

    // A direção do exercício depende da posição da opção depois dos negócios dela no dia (compra e exercício no mesmo dia,
    // recompra parcial). O líquido do dia vem pronto do índice acima: tempo linear mesmo com muitos exercícios (DoS).
    function exercicioEntrega(e) {
      var a = normalizarTicker(e.ativo), chave = e.data + '|' + a, q = pos[a] ? pos[a].qtd : 0;
      if (!feitos[chave]) q += liquidoDia[chave] || 0;
      if (Math.abs(q) < EPS) return false;
      return e.tipoOpcao === 'CALL' ? q > 0 : q < 0;
    }
    function anteciparExercicios(data) {
      (exerciciosDia[data] || []).forEach(function (idx) {
        var e = ops[idx].l;
        if (!exercicioEntrega(e)) return;
        antecipado[idx] = true;
        var a = normalizarTicker(e.ativo), chave = data + '|' + a;
        if (gruposDia[chave] && !feitos[chave]) { ordemAtual++; feitos[chave] = true; aplicarDia(a, gruposDia[chave]); marcar(data, a); }
        ordemAtual++;
        entregandoNoDia = true; aplicarEvento(e); entregandoNoDia = false;
        marcar(data, e.ativo, e.subjacente);
      });
    }
    function fecharLotes() {
      Object.keys(loteDia).forEach(function (a) {
        var L = loteDia[a], fator = L.entregue > 0 ? L.qtd / L.entregue : 0;
        L.exercicios.forEach(function (x) { x.premio *= fator; });   // o prêmio da parte vendida no dia não fica no custo fiscal
        if (L.qtd > EPS) { movimentar(pos[a], L.qtd, L.custo / L.qtd); if (L.semCusto) pos[a].pmDesconhecido = true; }
      });
      loteDia = Object.create(null); diaLote = null;
    }

    function aplicarSaldo(l) {
      var p = P(l.ativo, l.classe);
      if (!(l.qtd > 0)) { pend({ tipo: 'SALDO', id: l.id, ativo: p.ativo, data: l.data, texto: p.ativo + ': saldo inicial sem quantidade.' }); return; }
      if (l.pm == null || !(l.pm >= 0)) {
        p.qtd += l.qtd; p.pmDesconhecido = true;
        pend({ tipo: 'PM_DESCONHECIDO', id: l.id, ativo: p.ativo, data: l.data, texto: p.ativo + ': saldo inicial sem preço médio. Informe o preço médio da data de início (custo de aquisição, com taxas).' });
        return;
      }
      if (p.qtd < 0) { pend({ tipo: 'SALDO', id: l.id, ativo: p.ativo, data: l.data, texto: p.ativo + ': saldo inicial sobre posição vendida.' }); return; }
      movimentar(p, l.qtd, l.pm);
    }

    function aplicarDia(ativo, lista) {
      var p = P(ativo, lista[0].classe), classe = p.classe, m = mes(lista[0].data);
      // 1. custos obrigatórios
      var semCustos = lista.filter(function (o) { return !(typeof o.custos === 'number' && isFinite(o.custos) && o.custos >= 0); });
      semCustos.forEach(function (o) {
        pend({ tipo: 'CUSTOS', id: o.id, ativo: ativo, data: o.data, bloqueiaMes: true,
          texto: ativo + ' em ' + o.data + ': faltam os custos da nota (digite 0 se não houve). A operação não foi calculada.' });
      });
      var lotes = lista.map(function (o) {
        var c = (typeof o.custos === 'number' && isFinite(o.custos) && o.custos >= 0) ? o.custos : 0;
        return { o: o, resto: o.qtd, liq: o.lado === 'C' ? o.preco + c / o.qtd : o.preco - c / o.qtd, semCustos: semCustos.indexOf(o) >= 0 };
      });
      // 2. day trade por corretora, pareamento em sequência
      var porCorretora = Object.create(null);   // corretora é texto livre: "constructor" ou "__proto__" não podem cair no protótipo (7ª revisão, N1)
      lotes.forEach(function (x) { var k = chaveCorretora(x.o.corretora); (porCorretora[k] = porCorretora[k] || []).push(x); });
      Object.keys(porCorretora).forEach(function (k) {
        var fila = { C: [], V: [] };
        porCorretora[k].forEach(function (x) {
          var oposto = fila[x.o.lado === 'C' ? 'V' : 'C'];
          while (x.resto > EPS && oposto.length) {
            var y = oposto[0], q = Math.min(x.resto, y.resto);
            var compra = x.o.lado === 'C' ? x : y, venda = x.o.lado === 'C' ? y : x;
            var semC = compra.semCustos || venda.semCustos;
            registrar(venda.o, ativo, classe, categoria(classe, true), semC ? null : (venda.liq - compra.liq) * q, 'Day trade ' + q + ' un.');
            if (!semC && categoria(classe, true) !== CAT.FORA) {
              var kDt = lista[0].data + '\n' + categoria(classe, true) + '\n' + k;
              dtDia[kDt] = (dtDia[kDt] || 0) + (venda.liq - compra.liq) * q;
            }
            if (ehAcaoIsenta(classe)) addFora(m, q * venda.o.preco);
            x.resto -= q; y.resto -= q;
            if (y.resto <= EPS) oposto.shift();
          }
          if (x.resto > EPS) fila[x.o.lado].push(x);
        });
      });
      // 3. sobras: operação comum, na ordem dos negócios
      lotes.forEach(function (x) {
        if (x.resto <= EPS) return;
        var q = x.resto, o = x.o;
        if (classe === 'OPCAO') {   // saldo dos prêmios do dia, fora o day trade (IN 1.585, art. 63, § 8º)
          var kPr = o.data + '\n' + chaveCorretora(o.corretora);
          premiosDia[kPr] = (premiosDia[kPr] || 0) + (o.lado === 'V' ? q * o.preco : -q * o.preco);
        } else if (o.lado === 'V') somarBase(m, chaveCorretora(o.corretora), categoria(classe, false), q * o.preco);
        if (o.lado === 'C') {
          var vendidoAntes = p.qtd < 0;
          var resC = movimentar(p, q, x.liq);
          if (vendidoAntes) registrar(o, ativo, classe, categoria(classe, false), x.semCustos ? null : resC, 'Recompra (zeragem de posição vendida) ' + q + ' un.');
          return;
        }
        if (classe === 'OPCAO') {
          var comprado = p.qtd > 0, pmFalta = comprado && p.pmDesconhecido, r = movimentar(p, -q, x.liq);
          if (pmFalta) pmSemValor(o.id, ativo, o.data, 'venda');
          if (comprado) registrar(o, ativo, classe, categoria(classe, false), (x.semCustos || pmFalta) ? null : r, 'Venda ' + q + ' un.');
          return;
        }
        var L = loteDia[ativo], noLote = L ? L.qtd : 0;
        if (p.qtd + noLote + EPS < q) {
          if (ehAcaoIsenta(classe)) addVenda(m, q * o.preco);
          var tinha = Math.max(p.qtd, 0) + noLote;
          pend({ tipo: 'VENDA_ACIMA', id: o.id, ativo: ativo, data: o.data, bloqueiaMes: true, disponivel: tinha, excesso: q - tinha,
            texto: ativo + ' em ' + o.data + ': venda de ' + q + ' com ' + tinha + ' em carteira (' + (q - tinha) + ' acima). Corrija a quantidade ou lance a compra, o saldo inicial ou o evento que falta. A operação não foi calculada.' });
          registrar(o, ativo, classe, categoria(classe, false), null, 'Venda acima da posição', classe === 'DIREITO');
          p.qtd = 0; p.pm = 0; p.pmDesconhecido = false;
          if (L) { L.qtd = 0; L.custo = 0; }
          return;
        }
        var doLote = Math.min(q, noLote);
        if (doLote > EPS) {   // venda à vista na data do exercício: contra strike ± prêmio, não contra o PM (P&R 725/726; IN 1.585, art. 60)
          var custoLote = L.custo / L.qtd;
          registrar(o, ativo, classe, categoria(classe, false), (x.semCustos || L.semCusto) ? null : (x.liq - custoLote) * doLote,
            'Venda no mesmo dia do exercício de ' + L.opcao + (L.varias ? ' e outras' : '') + ' (' + doLote + ' un.)', true);
          if (ehAcaoIsenta(classe)) addFora(m, doLote * o.preco);
          L.custo -= custoLote * doLote; L.qtd -= doLote; q -= doLote;
          if (q <= EPS) return;
        }
        if (ehAcaoIsenta(classe)) addVenda(m, q * o.preco);
        var desconhecido = p.pmDesconhecido;
        var res = movimentar(p, -q, x.liq);
        if (desconhecido) {
          pend({ tipo: 'PM_DESCONHECIDO', id: o.id, ativo: ativo, data: o.data, bloqueiaMes: true,
            texto: ativo + ' em ' + o.data + ': venda sem preço médio conhecido (falta custo de bonificação ou do saldo inicial). A operação não foi calculada.' });
          if (p.qtd > 0) p.pmDesconhecido = true;
        }
        registrar(o, ativo, classe, categoria(classe, false), (desconhecido || x.semCustos) ? null : res, 'Venda ' + q + ' un.', classe === 'DIREITO');
      });
      lista.forEach(function (o) {
        addIrrf(m, categoria(classe, false), o.irrf);
        addIrrf(m, categoria(classe, true), o.irrfDT);
      });
    }

    function partir(nq) {   // quantidade nova → parte inteira e fração
      var inteiro = Math.floor(nq + EPS), fr = nq - inteiro;
      if (fr < 1e-6) fr = 0;
      return { inteiro: inteiro, fracao: fr };
    }
    function guardarFracao(p, l, qtdFr, custo) {
      if (!(qtdFr > 0)) return;
      if (p.fracao) { p.fracao.qtd += qtdFr; p.fracao.custo += custo; } else p.fracao = { qtd: qtdFr, custo: custo, desde: l.data };
      pend({ tipo: 'FRACAO', id: l.id, ativo: p.ativo, data: l.data, fracao: true,
        texto: p.ativo + ': fração de ' + (Math.round(p.fracao.qtd * 1e6) / 1e6).toString().replace('.', ',') + ' ação(ões) aguardando o leilão. Quando o valor for creditado, lance "Leilão de fração".' });
    }
    // Defesa contra entrada hostil ou digitação errada: quantidade resultante fora da faixa não é aplicada.
    function foraDaFaixa(e, p, nq) {
      if (isFinite(nq) && nq >= 0 && nq <= 1e12) return false;
      pend({ tipo: 'EVENTO', id: e.id, ativo: p.ativo, data: e.data, bloqueiaMes: true, texto: p.ativo + ' em ' + e.data + ': a proporção do evento leva a uma quantidade fora da faixa. Confira o "de/para" ou a proporção; o evento não foi aplicado.' });
      return true;
    }
    function semPosicao(l, p) {
      pend({ tipo: 'EVENTO_SEM_POSICAO', id: l.id, ativo: p.ativo, data: l.data, texto: p.ativo + ' em ' + l.data + ': evento sem ações em carteira na data. Confira a data ex e os lançamentos anteriores.' });
    }

    function aplicarEvento(e) {
      var p;
      if (e.tipo === 'DESDOBRAMENTO' || e.tipo === 'GRUPAMENTO') {
        p = P(e.ativo);
        var fator = e.fator != null ? e.fator : (e.para / e.de);
        if (!(fator > 0) || !isFinite(fator)) { pend({ tipo: 'EVENTO', id: e.id, ativo: p.ativo, data: e.data, texto: p.ativo + ': proporção do evento inválida.' }); return; }
        if (!(p.qtd > 0)) { semPosicao(e, p); return; }
        var custo = p.qtd * p.pm, nq = p.qtd * fator;
        if (foraDaFaixa(e, p, nq)) return;
        var pt = partir(nq), unit = custo / nq;
        if (p.fracao) p.fracao.qtd *= fator;
        p.qtd = pt.inteiro; p.pm = pt.inteiro ? unit : 0;
        guardarFracao(p, e, pt.fracao, pt.fracao * unit);
        return;
      }
      if (e.tipo === 'BONIFICACAO') {
        p = P(e.ativo);
        if (!(p.qtd > 0) && e.qtdNova == null) { semPosicao(e, p); return; }
        var novas = e.qtdNova != null ? e.qtdNova : p.qtd * e.para / e.de;
        if (foraDaFaixa(e, p, p.qtd + novas)) return;
        var b = partir(novas);
        bonificacoes.push({ data: e.data, ativo: p.ativo, qtd: novas, custoUnit: e.custoUnit == null ? null : e.custoUnit, valor: e.custoUnit == null || !(e.custoUnit >= 0) ? null : r2(novas * e.custoUnit) });
        avisos.push({ data: e.data, ativo: p.ativo, texto: p.ativo + ': bonificação em ' + e.data + '. A Receita entende que capitalizar lucros pode contar como distribuição de lucros (Lei 15.270/2025, limite de R$ 50 mil por mês por empresa); o tema é controverso. A aba Rendimentos soma o valor ao limite do mês.' });
        if (e.custoUnit == null || !(e.custoUnit >= 0)) {
          p.qtd += b.inteiro; p.pmDesconhecido = true;
          pend({ tipo: 'BONIFICACAO_SEM_CUSTO', id: e.id, ativo: p.ativo, data: e.data,
            texto: p.ativo + ': bonificação sem o custo atribuído. Ele está no aviso aos acionistas ou fato relevante da empresa (valor por ação). Sem ele, vendas seguintes não são calculadas.' });
          if (b.fracao) guardarFracao(p, e, b.fracao, 0);
          return;
        }
        if (b.inteiro) movimentar(p, b.inteiro, e.custoUnit);
        guardarFracao(p, e, b.fracao, b.fracao * e.custoUnit);
        return;
      }
      if (e.tipo === 'DIREITO_RECEBIDO') {
        p = P(e.ativo, 'DIREITO');
        if (e.qtd > 0) movimentar(p, e.qtd, 0);
        return;
      }
      if (e.tipo === 'SUBSCRICAO') {
        p = P(e.ativo);
        var custoDir = 0;
        if (e.direito) {
          var d = pos[normalizarTicker(e.direito)];
          if (d && d.qtd > 0) { var usa = Math.min(d.qtd, e.qtd); custoDir = usa * d.pm; d.qtd -= usa; if (d.qtd === 0) d.pm = 0; }
        }
        movimentar(p, e.qtd, e.preco + custoDir / e.qtd);
        return;
      }
      if (e.tipo === 'EXPIRACAO') {
        p = P(e.ativo, 'DIREITO');
        if (!(p.qtd > 0)) { semPosicao(e, p); return; }
        var perdido = p.qtd * p.pm;
        if (perdido > 0) {
          registrar(e, p.ativo, p.classe, categoria(p.classe, false), -perdido, 'Direito expirado sem exercício', true);
          avisos.push({ data: e.data, ativo: p.ativo, texto: p.ativo + ': direito comprado que expirou sem exercício; a perda de R$ ' + perdido.toFixed(2).replace('.', ',') + ' foi lançada como prejuízo comum. Confirme o tratamento com o contador.' });
        }
        p.qtd = 0; p.pm = 0;
        return;
      }
      if (e.tipo === 'INCORPORACAO') {
        p = P(e.ativo);
        if (!(p.qtd > 0)) { semPosicao(e, p); return; }
        var novo = P(e.novoAtivo), custoT = p.qtd * p.pm, nq2 = p.qtd * e.proporcao;
        if (foraDaFaixa(e, p, novo.qtd + nq2) || !(nq2 > 0)) return;
        var pt2 = partir(nq2), u2 = custoT / nq2;
        if (p.pmDesconhecido) novo.pmDesconhecido = true;
        if (pt2.inteiro) movimentar(novo, pt2.inteiro, u2);
        guardarFracao(novo, e, pt2.fracao, pt2.fracao * u2);
        if (p.fracao) { guardarFracao(novo, e, p.fracao.qtd * e.proporcao, p.fracao.custo); p.fracao = null; }
        p.qtd = 0; p.pm = 0; p.pmDesconhecido = false;
        avisos.push({ data: e.data, ativo: novo.ativo, texto: p.ativo + ' → ' + novo.ativo + ': custo de aquisição transferido sem apurar resultado. A Receita pode entender a incorporação de ações como alienação com ganho de capital (P&R IRPF, pergunta 603). Confira com o contador.' });
        return;
      }
      if (e.tipo === 'LEILAO_FRACAO') {
        p = P(e.ativo);
        if (!p.fracao) { pend({ tipo: 'EVENTO', id: e.id, ativo: p.ativo, data: e.data, texto: p.ativo + ': leilão de fração sem fração pendente.' }); return; }
        var desc = p.pmDesconhecido && p.fracao.custo === 0;
        registrar(e, p.ativo, p.classe, categoria(p.classe, false), desc ? null : e.valor - p.fracao.custo, 'Leilão de fração (' + p.fracao.qtd + ')', p.classe === 'DIREITO');
        if (ehAcaoIsenta(p.classe)) addVenda(mes(e.data), e.valor);   // premissa: alienação em bolsa = venda à vista
        p.fracao = null;
        return;
      }
      if (e.tipo === 'VENCIMENTO' || e.tipo === 'EXERCICIO') {
        p = pos[normalizarTicker(e.ativo)];
        if (!p || !p.qtd) { pend({ tipo: 'EVENTO_SEM_POSICAO', id: e.id, ativo: normalizarTicker(e.ativo), data: e.data, texto: normalizarTicker(e.ativo) + ': evento de opção sem posição.' }); return; }
        if (e.tipo === 'VENCIMENTO') {
          var pmFaltaV = p.pmDesconhecido, resV = movimentar(p, -p.qtd, 0);
          if (pmFaltaV) pmSemValor(e.id, p.ativo, e.data, 'vencimento');
          registrar(e, p.ativo, 'OPCAO', CAT.COMUM, pmFaltaV ? null : resV, 'Opção vencida sem exercício');
          return;
        }
        var total = Math.abs(p.qtd), titular = p.qtd > 0, premio = p.pm;
        var q = e.qtd != null ? e.qtd : total;
        if (!(q > 0) || q > total + EPS) {
          pend({ tipo: 'EXERCICIO_ACIMA', id: e.id, ativo: p.ativo, data: e.data, bloqueiaMes: true,
            texto: p.ativo + ' em ' + e.data + ': exercício de ' + q + ' com ' + total + ' em carteira. Corrija a quantidade exercida ou lance o negócio que falta. O exercício não foi aplicado.' });
          return;
        }
        subDeExercicio[p.ativo] = normalizarTicker(e.subjacente);
        var cadE = cad(p.ativo), letraE = classificar(p.ativo, null, null).tipoOpcao;
        if ((cadE && cadE.tipo && cadE.tipo !== e.tipoOpcao) || (letraE && letraE !== e.tipoOpcao))
          avisos.push({ data: e.data, ativo: p.ativo, texto: p.ativo + ': o exercício foi lançado como ' + e.tipoOpcao + ', mas ' + (cadE && cadE.tipo && cadE.tipo !== e.tipoOpcao ? 'o cadastro diz ' + cadE.tipo : 'a letra do código indica ' + letraE) + '. Confira o exercício (o tipo decide se as ações entram ou saem).' });
        var s = P(e.subjacente, e.classeSub);
        var custoUnit = (e.custos || 0) / q, premioFalta = p.pmDesconhecido;
        p.qtd += titular ? -q : q;
        if (Math.abs(p.qtd) < EPS) { p.qtd = 0; p.pm = 0; p.pmDesconhecido = false; }
        // titular de call compra a strike+prêmio; lançador de call vende a strike+prêmio;
        // titular de put vende a strike−prêmio; lançador de put compra a strike−prêmio (IN 1.585, art. 60, § 1º; P&R 725 e 726).
        var compra = e.tipoOpcao === 'CALL' ? titular : !titular;
        var preco = e.tipoOpcao === 'CALL' ? e.strike + premio : e.strike - premio;
        var registroEx = { ordem: ordemAtual, data: e.data, opcao: p.ativo, subjacente: s.ativo, compra: compra, premio: q * premio };
        exercicios.push(registroEx);
        if (compra) {
          if (premioFalta) pmSemValor(e.id, p.ativo, e.data, 'exercício');
          if (!entregandoNoDia) { movimentar(s, q, preco + custoUnit); if (premioFalta) s.pmDesconhecido = true; return; }
          var lote = loteDia[s.ativo] || (loteDia[s.ativo] = { qtd: 0, entregue: 0, custo: 0, opcao: p.ativo, varias: false, exercicios: [] });
          lote.qtd += q; lote.entregue += q; lote.custo += q * (preco + custoUnit); lote.exercicios.push(registroEx); if (premioFalta) lote.semCusto = true;
          if (lote.opcao !== p.ativo) lote.varias = true;
          diaLote = e.data;
          return;
        }
        if (!(s.qtd >= q)) {
          pend({ tipo: 'VENDA_ACIMA', id: e.id, ativo: s.ativo, data: e.data, bloqueiaMes: true, texto: s.ativo + ': exercício vendedor sem ações suficientes em carteira (lançamento descoberto não modelado).' });
          registrar(e, s.ativo, s.classe, categoria(s.classe, false), null, 'Venda por exercício de ' + p.ativo, true);
          s.qtd = 0; s.pm = 0; s.pmDesconhecido = false; return;
        }
        var semValor = premioFalta || s.pmDesconhecido;
        var r = movimentar(s, -q, preco - custoUnit);
        if (semValor) pmSemValor(e.id, s.ativo, e.data, 'venda por exercício');
        // Venda por exercício: lucro sempre tributável (IN 1.585/2015, art. 59, § 2º, IV).
        registrar(e, s.ativo, s.classe, categoria(s.classe, false), semValor ? null : r, 'Venda por exercício de ' + p.ativo + (q < total ? ' (parcial: ' + q + ' de ' + total + ')' : ''), true);
        if (ehAcaoIsenta(s.classe)) addFora(mes(e.data), q * e.strike);
      }
    }

    var opc = resumoOpcoes();

    // Avisos por classe: fora do cálculo
    Object.keys(classeDe).forEach(function (a) {
      if (classeDe[a] === 'FIINFRA' || classeDe[a] === 'ETF_RF')
        avisos.push({ ativo: a, texto: a + ' (' + NOME_CLASSE[classeDe[a]] + '): tributação própria, fora do cálculo do site. Confira com o contador.' });
    });

    var irrfEstimado = opcoes.estimarIrrf ? estimarIrrf() : {};
    var irrfOrigem = {}, irrfUsado = montarIrrf();
    var apuracao = apurar(extrato, vendas, irrfUsado, config, vendasFora, incompletos, irrfOrigem);
    return { versao: VERSAO, posicoes: pos, extrato: extrato, pendencias: pendencias, avisos: avisos, bonificacoes: bonificacoes, vendasAcoesMes: vendas,
      vendasForaIsencaoMes: vendasFora, irrfMes: irrfUsado, irrfEstimado: irrfEstimado, mesesIncompletos: incompletos, apuracao: apuracao,
      opcoesAbertas: opc.abertas, cobertura: opc.cobertura, caixaPuts: opc.caixaPuts, campanhas: opc.campanhas };

    /* ---------- IRRF: estimativa pelas bases do mês; o valor da nota substitui, por mês e categoria ---------- */
    function estimarIrrf() {
      var est = {};
      Object.keys(premiosDia).forEach(function (k) {
        if (premiosDia[k] > 0) somarBase(mes(k.slice(0, 10)), k.slice(11), CAT.COMUM, premiosDia[k]);
      });
      Object.keys(baseFonte).forEach(function (m) {
        Object.keys(baseFonte[m]).forEach(function (cor) {
          var b = baseFonte[m][cor];
          if ((b.COMUM + b.FII) * 0.00005 <= 1 + EPS) return;   // até R$ 1,00 no mês não há retenção
          var e = est[m] || (est[m] = { COMUM: 0, DAYTRADE: 0, FII: 0 });
          e.COMUM += b.COMUM * 0.00005; e.FII += b.FII * 0.00005;
        });
      });
      Object.keys(dtDia).forEach(function (k) {
        if (!(dtDia[k] > 0)) return;
        var p = k.split('\n'), e = est[mes(p[0])] || (est[mes(p[0])] = { COMUM: 0, DAYTRADE: 0, FII: 0 });
        e[p[1]] += dtDia[k] * 0.01;
      });
      Object.keys(est).forEach(function (m) { ['COMUM', 'DAYTRADE', 'FII'].forEach(function (c) { est[m][c] = r2(est[m][c]); }); });
      return est;
    }
    function montarIrrf() {
      var informado = opcoes.irrfInformado || {}, usado = {}, meses = Object.create(null);
      function temP(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
      [irrf, irrfEstimado, informado].forEach(function (o) { Object.keys(o).forEach(function (m) { meses[m] = true; }); });
      Object.keys(meses).forEach(function (m) {
        ['COMUM', 'DAYTRADE', 'FII'].forEach(function (c) {
          var inf = temP(informado, m) && temP(informado[m], c) ? informado[m][c] : null;
          var neg = temP(irrf, m) && irrf[m][c] > 0 ? irrf[m][c] : 0, est = temP(irrfEstimado, m) ? irrfEstimado[m][c] : 0;
          var v = 0, origem = null;
          if (typeof inf === 'number' && isFinite(inf) && inf >= 0) { v = inf; origem = 'nota'; }
          else if (neg > 0) { v = neg; origem = 'nota'; }
          else if (est > 0) { v = est; origem = 'estimado'; }
          if (origem) {
            (usado[m] = usado[m] || {})[c] = v;
            (irrfOrigem[m] = irrfOrigem[m] || {})[c] = origem;
          }
        });
      });
      return usado;
    }

    /* ---------- opções em aberto, cobertura, caixa das puts e campanhas (gerencial) ---------- */
    function infoOpcao(a) {
      var c = cad(a), cl = classificar(a, null, null);
      var tipo = c && (c.tipo === 'CALL' || c.tipo === 'PUT') ? c.tipo : (cl.tipoOpcao || null);
      return { subjacente: c && c.subjacente ? normalizarTicker(c.subjacente) : (subDeExercicio[a] || null), tipo: tipo,
        strike: c && typeof c.strike === 'number' && isFinite(c.strike) ? c.strike : null, vencimento: c && c.vencimento ? c.vencimento : null,
        cadastrada: !!c, tipoDoCodigo: cl.tipoOpcao || null };
    }
    function resumoOpcoes() {
      var abertas = [], grupos = {}, cobertura = {}, caixa = { total: 0, semStrike: [], porAtivo: {} };
      Object.keys(pos).sort().forEach(function (a) {
        if (pos[a].classe !== 'OPCAO') return;
        var inf = infoOpcao(a), p = pos[a];
        if (inf.subjacente) (grupos[inf.subjacente] = grupos[inf.subjacente] || []).push(a);
        if (inf.cadastrada && inf.tipoDoCodigo && inf.tipo !== inf.tipoDoCodigo)
          avisos.push({ ativo: a, texto: a + ': o cadastro diz ' + inf.tipo + ', mas a letra do código indica ' + inf.tipoDoCodigo + '. Confira o cadastro da opção.' });
        if (!p.qtd) return;
        var vencida = !!(hoje && inf.vencimento && hoje > inf.vencimento);
        abertas.push({ ativo: a, qtd: p.qtd, pm: p.pm, subjacente: inf.subjacente, tipo: inf.tipo, strike: inf.strike, vencimento: inf.vencimento,
          cadastrada: inf.cadastrada, vencida: vencida });
        if (vencida) pend({ tipo: 'VENCIMENTO_PENDENTE', ativo: a, data: inf.vencimento, bloqueiaMes: true,
          texto: a + ' venceu em ' + inf.vencimento + ' e ainda está em carteira (' + p.qtd + '). Lance o vencimento (virou pó) ou o exercício.' });
        if (!inf.cadastrada) pend({ tipo: 'OPCAO_CADASTRO', ativo: a, info: true,
          texto: a + ': informe o ativo-objeto, o tipo, o strike e o vencimento da opção. Sem isso, a cobertura, o caixa das puts e a campanha não aparecem (o imposto não depende disso).' });
        if (inf.tipo === 'PUT' && p.qtd < 0) {
          if (inf.strike == null) caixa.semStrike.push(a);
          else { var v = -p.qtd * inf.strike; caixa.total += v; if (inf.subjacente) caixa.porAtivo[inf.subjacente] = (caixa.porAtivo[inf.subjacente] || 0) + v; }
        }
      });
      caixa.total = r2(caixa.total);
      Object.keys(grupos).forEach(function (sub) {
        var acoes = pos[sub] ? Math.max(pos[sub].qtd, 0) : 0, calls = 0;
        grupos[sub].forEach(function (a) { var inf = infoOpcao(a); if (inf.tipo === 'CALL' && pos[a].qtd < 0) calls += -pos[a].qtd; });
        var desc = Math.max(0, calls - acoes);
        cobertura[sub] = { acoes: acoes, callsVendidas: calls, descoberta: desc };
        if (desc > 0) avisos.push({ ativo: sub, texto: sub + ': ' + desc + ' call(s) vendida(s) descoberta(s) (' + calls + ' vendidas, ' + acoes + ' ações em carteira). No exercício, faltariam ações para entregar.' });
      });
      return { abertas: abertas, cobertura: cobertura, caixaPuts: caixa, campanhas: montarCampanhas(grupos) };
    }
    function montarCampanhas(gruposOpcoes) {
      // Índices por ativo (uma passada em marcos, extrato e exercícios): evita varrer tudo para cada ativo (6ª/7ª revisões: DoS).
      var subs = {}, marcosDe = {}, extratoDe = {}, exercDe = {};
      Object.keys(pos).forEach(function (a) { if (pos[a].classe && pos[a].classe !== 'OPCAO') subs[a] = true; });
      Object.keys(gruposOpcoes).forEach(function (sub) { subs[sub] = true; });
      marcos.forEach(function (m) { (marcosDe[m.ativo] = marcosDe[m.ativo] || []).push(m); });
      extrato.forEach(function (x) { (extratoDe[x.ativo] = extratoDe[x.ativo] || []).push(x); });
      exercicios.forEach(function (x) { (exercDe[x.opcao] = exercDe[x.opcao] || []).push(x); });
      function porOrdemAsc(a, b) { return a.ordem - b.ordem; }
      var saida = [];
      Object.keys(subs).sort().forEach(function (sub) {
        var membros = [sub].concat(gruposOpcoes[sub] || []), ehMembro = {};
        membros.forEach(function (a) { ehMembro[a] = true; });
        var ms = [], linhas = [], exs = [];
        membros.forEach(function (a) {
          if (marcosDe[a]) ms = ms.concat(marcosDe[a]);
          if (extratoDe[a]) linhas = linhas.concat(extratoDe[a]);
          if (exercDe[a]) exs = exs.concat(exercDe[a]);
        });
        if (membros.length > 1) { ms.sort(porOrdemAsc); linhas.sort(porOrdemAsc); exs.sort(porOrdemAsc); }
        var qtd = {}, abertos = 0, c = null, lista = [];
        for (var k = 0; k < ms.length;) {
          var ordem = ms[k].ordem, data = ms[k].data;
          for (; k < ms.length && ms[k].ordem === ordem; k++) {   // uma operação pode mexer em opção e ação juntas
            var m = ms[k], antes = Math.abs(qtd[m.ativo] || 0) > EPS, depois = Math.abs(m.qtd) > EPS;
            qtd[m.ativo] = m.qtd; abertos += (depois ? 1 : 0) - (antes ? 1 : 0);
          }
          if (!c && abertos > 0) c = { subjacente: sub, inicio: data, fim: null, ordemInicio: ordem, ordemFim: Infinity };
          else if (c && abertos === 0) { c.fim = data; c.ordemFim = ordem; lista.push(c); c = null; }
        }
        if (c) lista.push(c);
        var il = 0, ie = 0;
        lista.forEach(function (k2) {
          var ro = 0, ra = 0, incompleta = false, temOpcoes = false, premioNoCusto = 0;
          while (il < linhas.length && linhas[il].ordem < k2.ordemInicio) il++;
          for (; il < linhas.length && linhas[il].ordem <= k2.ordemFim; il++) {
            var x = linhas[il];
            if (x.classe === 'OPCAO') temOpcoes = true;
            if (x.resultado == null) { incompleta = true; continue; }
            if (x.classe === 'OPCAO') ro += x.resultado; else ra += x.resultado;
          }
          while (ie < exs.length && exs[ie].ordem < k2.ordemInicio) ie++;
          for (; ie < exs.length && exs[ie].ordem <= k2.ordemFim; ie++) { temOpcoes = true; if (exs[ie].compra) premioNoCusto += exs[ie].premio; }
          var aberta = k2.fim === null, premioEmAberto = 0, premioPagoEmAberto = 0, aguardando = [];
          if (aberta) (gruposOpcoes[sub] || []).forEach(function (a) {
            var p = pos[a]; if (!p.qtd) return; temOpcoes = true;
            if (p.qtd < 0) premioEmAberto += -p.qtd * p.pm; else premioPagoEmAberto += p.qtd * p.pm;
            var venc = infoOpcao(a).vencimento;   // P1: a campanha só fecha com lançamento; opção vencida fica aguardando
            if (hoje && venc && hoje > venc) aguardando.push({ ativo: a, vencimento: venc, qtd: p.qtd });
          });
          var ps = pos[sub], q = aberta && ps ? Math.max(ps.qtd, 0) : 0;
          var custoF = aberta && ps && !ps.pmDesconhecido ? q * ps.pm : null;
          var custoG = custoF == null ? null : custoF - ro;
          saida.push({ subjacente: sub, inicio: k2.inicio, fim: k2.fim, aberta: aberta, temOpcoes: temOpcoes, incompleta: incompleta,
            resultadoAcoes: r2(ra), resultadoOpcoes: r2(ro), resultado: r2(ra + ro),
            qtd: q, custoFiscal: r2(custoF), pmFiscal: q > 0 && custoF != null ? custoF / q : null,
            custoGerencial: r2(custoG), pmGerencial: q > 0 && custoG != null ? custoG / q : null,
            premioNoCusto: r2(premioNoCusto), premioEmAberto: r2(premioEmAberto), premioPagoEmAberto: r2(premioPagoEmAberto), aguardando: aguardando });
        });
      });
      return saida;
    }
  }

  /** Apuração mensal com compensação de prejuízos por categoria e DARF (código 6015). */
  function apurar(extrato, vendas, irrf, config, vendasFora, incompletos, irrfOrigem) {
    config = Object.assign({ volumeForaIsencaoContaNoLimite: true, prejuizoMesIsentoCompensa: true }, config || {});
    vendasFora = vendasFora || {}; incompletos = incompletos || {}; irrfOrigem = irrfOrigem || {};
    var meses = {}; extrato.forEach(function (x) { meses[x.mes] = true; });
    Object.keys(irrf).forEach(function (m) { meses[m] = true; });
    Object.keys(incompletos).forEach(function (m) { meses[m] = true; });
    var lista = Object.keys(meses).sort();
    var prej = { COMUM: 0, DAYTRADE: 0, FII: 0 }, irrfAcum = { COMUM: 0, DAYTRADE: 0, FII: 0 }, darfAcum = 0;
    var saida = [], primeiroIncompleto = null, linhasDoMes = {};
    extrato.forEach(function (x) { (linhasDoMes[x.mes] = linhasDoMes[x.mes] || []).push(x); });

    lista.forEach(function (m, iMes) {
      var linhas = linhasDoMes[m] || [];
      var volComum = vendas[m] || 0, volFora = vendasFora[m] || 0;
      var isentoSemFora = volComum <= LIMITE_ISENCAO, isentoComFora = volComum + volFora <= LIMITE_ISENCAO;
      var isento = config.volumeForaIsencaoContaNoLimite ? isentoComFora : isentoSemFora;
      var res = { COMUM: 0, DAYTRADE: 0, FII: 0 }, acoesIsento = 0, lucroAcoesComum = 0;
      linhas.forEach(function (x) {
        if (x.resultado == null || !x.categoria || x.categoria === CAT.FORA) return;
        var acao = x.categoria === 'COMUM' && ehAcaoIsenta(x.classe) && !x.naoIsenta;
        if (acao) lucroAcoesComum += x.resultado;
        if (acao && isento) {
          if (x.resultado > 0) { acoesIsento += x.resultado; return; }
          if (!config.prejuizoMesIsentoCompensa) return;
        }
        res[x.categoria] += x.resultado;
      });
      var mesOut = { mes: m, vendasAcoes: r2(volComum), vendasForaIsencao: r2(volFora), isencao20k: isento,
        lucroIsentoAcoes: r2(acoesIsento), categorias: {}, avisos: [],
        incompleto: !!(incompletos[m] && incompletos[m].length), motivos: (incompletos[m] || []).slice(),
        dependeDe: primeiroIncompleto };   // mês incompleto muda os prejuízos e o saldo de IRRF dos meses seguintes
      if (mesOut.incompleto && !primeiroIncompleto) primeiroIncompleto = m;
      if (isentoSemFora !== isentoComFora && lucroAcoesComum > 0) {
        mesOut.avisos.push('A premissa sobre o volume de day trade/exercício decide a isenção neste mês (diferença aprox. R$ ' +
          r2(lucroAcoesComum * ALIQ.COMUM) + ' de imposto). Usado: ' + (config.volumeForaIsencaoContaNoLimite ? 'conta no limite (conservador)' : 'não conta') + '. Caso para contador.');
      }
      var impostoTotal = 0;
      ['COMUM', 'DAYTRADE', 'FII'].forEach(function (c) {
        var base = res[c] - prej[c], prejAnterior = prej[c];
        var imposto = 0;
        if (base > 0) { imposto = r2(base * ALIQ[c]); prej[c] = 0; } else { prej[c] = -base; }   // centavos por categoria: a tela soma as linhas
        var irMes = (irrf[m] || {})[c] || 0, ir = irMes + irrfAcum[c];
        var devido = Math.max(0, imposto - ir);
        var anterior = irrfAcum[c];
        irrfAcum[c] = imposto > 0 ? Math.max(0, ir - imposto) : ir;
        impostoTotal += devido;
        mesOut.categorias[c] = { resultado: r2(res[c]), prejuizoAnterior: r2(prejAnterior), base: r2(Math.max(base, 0)), aliquota: ALIQ[c],
          imposto: r2(imposto), irrfMes: r2(irMes), irrfOrigem: (irrfOrigem[m] || {})[c] || null, irrfAnterior: r2(anterior),
          irrfDeduzido: r2(Math.min(ir, imposto)), irrfSaldo: r2(irrfAcum[c]), prejuizoAcumulado: r2(prej[c]) };
      });
      var aPagar = r2(r2(impostoTotal) + darfAcum);
      if (darfAcum > 0) mesOut.darfAcumuladoAnterior = r2(darfAcum);
      if (aPagar < DARF_MINIMO) { darfAcum = aPagar; mesOut.darf = 0; mesOut.darfAcumuladoParaProximo = r2(aPagar); }
      else { darfAcum = 0; mesOut.darf = r2(aPagar); }
      // O saldo de IRRF só vale até dezembro do ano da retenção (P&R 715); o que sobra vai para a declaração.
      var prox = lista[iMes + 1];
      if (m.slice(5, 7) === '12' || (prox && prox.slice(0, 4) !== m.slice(0, 4))) {
        var sobra = {}, temSobra = false;
        ['COMUM', 'DAYTRADE', 'FII'].forEach(function (c) { if (irrfAcum[c] > 0) { sobra[c] = r2(irrfAcum[c]); temSobra = true; } irrfAcum[c] = 0; });
        if (temSobra) mesOut.irrfParaDeclaracao = sobra;
      }
      mesOut.codigoDarf = '6015';
      mesOut.vencimento = 'último dia útil de ' + proximoMes(m);
      saida.push(mesOut);
    });
    return saida;
  }

  function proximoMes(m) {
    var a = +m.slice(0, 4), b = +m.slice(5, 7) + 1;
    if (b > 12) { b = 1; a++; }
    return a + '-' + String(b).padStart(2, '0');
  }

  /** Vencimento do DARF do mês: último dia útil do mês seguinte, pela lista de feriados (o Sicalc confirma). */
  function vencimentoDarf(m, feriados) {
    if (!/^\d{4}-\d\d$/.test(String(m || ''))) return null;
    var fer = Object.create(null); (feriados || []).forEach(function (d) { fer[d] = true; });
    var a = +m.slice(0, 4), b = +m.slice(5, 7);   // Date.UTC(a, b + 1, 0): último dia do mês seguinte (b já é o mês + 1 em base 0)
    var x = new Date(Date.UTC(a, b + 1, 0));
    function iso(d) { return d.toISOString().slice(0, 10); }
    while (x.getUTCDay() === 0 || x.getUTCDay() === 6 || fer[iso(x)]) x = new Date(x.getTime() - 86400000);
    return iso(x);
  }

  /**
   * Painel do IR por mês, do mais recente para o mais antigo. opcoes: { pagos: { 'AAAA-MM': { pagoEm, valor } }, hoje, feriados }.
   * Situação: INCOMPLETO e DEPENDE (sem valor) · SEM_IMPOSTO · ACUMULA (abaixo de R$ 10) · A_PAGAR · VENCIDO · PAGO · PAGO_DIFERENTE.
   * emAberto = meses encerrados com DARF sem pagar + diferença a maior de DARF pago. mesAtual = DARF parcial do mês em andamento.
   */
  function painelIR(apuracao, opcoes) {
    opcoes = opcoes || {};
    var pagos = opcoes.pagos || {}, hoje = opcoes.hoje || null, porMes = Object.create(null), meses = [];
    (apuracao || []).forEach(function (x) { porMes[x.mes] = x; meses.push(x.mes); });
    Object.keys(pagos).forEach(function (m) { if (!porMes[m]) meses.push(m); });   // DARF pago de mês que ficou sem lançamentos
    meses.sort();
    var emAberto = 0, mesAtual = null, bloqueados = 0, ultimo = apuracao && apuracao.length ? apuracao[apuracao.length - 1] : null;
    var lista = meses.map(function (m) {
      var x = porMes[m] || null, pago = Object.prototype.hasOwnProperty.call(pagos, m) ? pagos[m] : null;
      var venc = vencimentoDarf(m, opcoes.feriados), emAndamento = !!hoje && hoje.slice(0, 7) <= m;
      var semValor = !!x && (x.incompleto || !!x.dependeDe), darf = x ? x.darf : 0, sit, dif = null;
      if (semValor) { sit = x.incompleto ? 'INCOMPLETO' : 'DEPENDE'; bloqueados++; darf = null; }
      else if (pago) {
        dif = r2(darf - pago.valor);
        sit = Math.abs(dif) < 0.005 ? 'PAGO' : 'PAGO_DIFERENTE';
        if (sit === 'PAGO') dif = 0; else if (dif > 0 && !emAndamento) emAberto += dif;
      }
      else if (darf > 0) {
        sit = hoje && hoje > venc ? 'VENCIDO' : 'A_PAGAR';
        if (emAndamento) mesAtual = { mes: m, valor: darf }; else emAberto += darf;
      }
      else sit = x && x.darfAcumuladoParaProximo > 0 ? 'ACUMULA' : 'SEM_IMPOSTO';
      return { mes: m, situacao: sit, darf: darf, vencimento: venc, emAndamento: emAndamento, pago: pago, diferenca: dif,
        acumuladoAnterior: x && x.darfAcumuladoAnterior ? x.darfAcumuladoAnterior : 0, acumulaParaProximo: x && x.darfAcumuladoParaProximo ? x.darfAcumuladoParaProximo : 0,
        dependeDe: x ? x.dependeDe : null, motivos: x ? x.motivos : [], apuracao: x };
    }).reverse();
    var prej = ultimo ? { COMUM: ultimo.categorias.COMUM.prejuizoAcumulado, DAYTRADE: ultimo.categorias.DAYTRADE.prejuizoAcumulado, FII: ultimo.categorias.FII.prejuizoAcumulado } : { COMUM: 0, DAYTRADE: 0, FII: 0 };
    return { meses: lista, emAberto: r2(emAberto), mesAtual: mesAtual, mesesSemValor: bloqueados, prejuizos: prej,
      prejuizosConfiaveis: !bloqueados, primeiroBloqueio: (function () { for (var i = lista.length - 1; i >= 0; i--) if (lista[i].situacao === 'INCOMPLETO') return lista[i].mes; return null; })() };
  }

  /**
   * Vencimento sugerido pela letra do código (premissa P6: só pré-preenche o formulário).
   * Mensal: 3ª sexta-feira do mês da letra; semanal (sufixo Wn): n-ésima sexta. Sem pregão (fim de semana ou feriado da
   * lista) → pregão anterior. O mês é o próximo, a partir da data de referência. Não é opção → null.
   */
  function vencimentoSugerido(ticker, dataRef, feriados) {
    var t = normalizarTicker(ticker), o = /^[A-Z][A-Z0-9]{3}([A-X])\d{1,3}[A-Z0-9]?(W([1-5]))?$/.exec(t);
    if (!o || !/^\d{4}-\d\d-\d\d$/.test(String(dataRef || ''))) return null;
    var fer = {}; (feriados || []).forEach(function (d) { fer[d] = true; });
    var mesL = (o[1].charCodeAt(0) - 65) % 12, n = o[3] ? +o[3] : 3;
    var ano = +dataRef.slice(0, 4), mesR = +dataRef.slice(5, 7) - 1;
    function iso(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); }
    function calcular(a) {
      var d = new Date(Date.UTC(a, mesL, 1)), primeira = 1 + ((5 - d.getUTCDay() + 7) % 7), dia = primeira + 7 * (n - 1);
      var x = new Date(Date.UTC(a, mesL, dia));
      if (x.getUTCMonth() !== mesL) return null;
      while (x.getUTCDay() === 0 || x.getUTCDay() === 6 || fer[iso(x)]) x = new Date(x.getTime() - 86400000);
      return iso(x);
    }
    var a = mesL < mesR ? ano + 1 : ano, r = calcular(a);
    if (r && r < dataRef) r = calcular(a + 1);
    return r;
  }

  /* ---------- utilitários da tela (puros, testados) ---------- */

  /** Resultado não realizado pela cotação digitada. Sem cotação ou sem PM → null (nunca zero). */
  function naoRealizado(p, cotacao) {
    if (!p || !(p.qtd > 0) || p.pmDesconhecido || !cotacao || !(typeof cotacao.valor === 'number' && cotacao.valor > 0)) return null;
    var custo = p.qtd * p.pm, mercado = p.qtd * cotacao.valor;
    return { valorMercado: r2(mercado), custo: r2(custo), resultado: r2(mercado - custo), pct: custo > 0 ? (mercado - custo) / custo : null };
  }

  /**
   * Aviso de backup antigo (decisão 30): 7 dias ou mais, ou 10 lançamentos ou mais criados/alterados depois do
   * último backup — o que vier primeiro. Sem backup: aviso assim que houver lançamento.
   */
  function avisoBackup(ultimoBackupIso, lancamentos, agoraIso) {
    var lista = Array.isArray(lancamentos) ? lancamentos : [];
    if (!ultimoBackupIso) return { mostrar: lista.length > 0, nunca: true, dias: null, depois: lista.length };
    var depois = lista.filter(function (l) { var t = l.atualizadoEm || l.criadoEm; return t && t > ultimoBackupIso; }).length;
    var dias = Math.floor((Date.parse(agoraIso) - Date.parse(ultimoBackupIso)) / 86400000);
    return { mostrar: (lista.length > 0 && dias >= 7) || depois >= 10, nunca: false, dias: dias, depois: depois };
  }

  /* ================= F5: proventos, aluguel e estimados ================= */
  /* Regras: Lei 13.043/2014, arts. 6º e 7º; Lei 11.033/2004, art. 1º; Lei 9.249/1995, art. 9º, § 2º (LC 224/2025); Lei 9.250/1995, art. 6º-A (Lei 15.270/2025). */
  var LIMITE_DIVIDENDOS = 50000, ALIQ_DIVIDENDOS = 0.10;
  function aliquotaAluguel(dias) { return dias <= 180 ? 0.225 : dias <= 360 ? 0.20 : dias <= 720 ? 0.175 : 0.15; }
  function aliquotaJcp(data) { return String(data) < '2026-01-01' ? 0.15 : 0.175; }
  function diasEntre(de, ate) { return Math.round((Date.parse(ate + 'T00:00:00Z') - Date.parse(de + 'T00:00:00Z')) / 86400000); }
  function raizEmpresa(ativo) { return normalizarTicker(ativo).slice(0, 4); }
  function numero(x) { return typeof x === 'number' && isFinite(x); }
  /** Um item da aba Rendimentos → bruto, IR, líquido e coluna. IR informado substitui a estimativa, inclusive 0. */
  function calcularRendimento(i) {
    var aluguel = i.tipo === 'ALUGUEL', reembolso = i.origem === 'REEMBOLSO';
    var bruto = r2(aluguel ? i.bruto : i.qtd * i.valorUnit), irrf = 0, origem = 'SEM', aliq = null, prazo = null, falta = null;
    if (aluguel && i.inicio) prazo = diasEntre(i.inicio, i.pagamento);
    if (numero(i.irrf)) { irrf = i.irrf; origem = 'INFORMADO'; }
    else if (i.tipo === 'JCP') { aliq = aliquotaJcp(i.pagamento || i.dataCom); irrf = r2(bruto * aliq); origem = 'ESTIMADO'; }
    else if (aluguel) {
      if (prazo != null) { aliq = aliquotaAluguel(prazo); irrf = r2(bruto * aliq); origem = 'ESTIMADO'; }
      else { irrf = null; falta = 'IR retido'; }
    }
    var custos = numero(i.custos) ? i.custos : 0;
    return { bruto: bruto, irrf: irrf, irrfOrigem: origem, aliquota: aliq, prazoDias: prazo, custos: custos, falta: falta,
      liquido: falta ? null : r2(bruto - irrf - custos),
      coluna: aluguel ? 'ALUGUEL' : reembolso ? 'REEMBOLSO' : i.tipo === 'RENDIMENTO_FII' ? 'FII' : i.tipo,
      isento: reembolso || i.tipo === 'DIVIDENDO' || i.tipo === 'RENDIMENTO_FII' };
  }
  /**
   * Quadro da aba Rendimentos. opcoes: { hoje, bonificacoes (de processar), manual (classes escolhidas) }.
   * Mês = data de pagamento. Só o já pago entra nos meses; data futura = a receber; sem data = anunciado.
   * Alerta por raiz do código e mês: dividendos da empresa (com data de pagamento) + capitalização; reembolso fora, com nota.
   */
  function painelRendimentos(itens, opcoes) {
    opcoes = opcoes || {};
    var hoje = opcoes.hoje || '9999-12-31', anoHoje = hoje.slice(0, 4), meses = Object.create(null), grupos = Object.create(null);
    var linhas = [], pendencias = [], avisos = [], avisados = Object.create(null);
    var res = { ano: anoHoje, liquidoAno: 0, irrfAno: 0, faltasAno: 0, aReceber: 0, nAReceber: 0, faltasAReceber: 0 };
    function grupo(raiz, m) { var k = raiz + '|' + m; return grupos[k] || (grupos[k] = { raiz: raiz, mes: m, dividendos: 0, capitalizacao: 0, reembolso: 0, ativos: Object.create(null), semCusto: [] }); }
    (itens || []).forEach(function (i) {
      var c = calcularRendimento(i), data = i.pagamento || null;
      var sit = !data ? 'ANUNCIADO' : data > hoje ? 'A_RECEBER' : 'RECEBIDO';
      var m = data ? mes(data) : null;
      linhas.push({ item: i, calc: c, situacao: sit, mes: m });
      if (c.falta) pendencias.push({ id: i.id, ativo: i.ativo, data: data, tipo: 'FALTA_IR', texto: i.ativo + ': aluguel de ' + data + ' sem o IR retido. Informe o IR do extrato ou o início do contrato.' });
      if (sit === 'RECEBIDO') {
        var q = meses[m] || (meses[m] = { mes: m, DIVIDENDO: 0, JCP: 0, FII: 0, ALUGUEL: 0, REEMBOLSO: 0, irrf: 0, faltam: 0, total: 0, _falta: Object.create(null) });
        if (c.falta) { q.faltam++; q._falta[c.coluna] = true; if (m.slice(0, 4) === anoHoje) res.faltasAno++; }
        else {
          q[c.coluna] += c.liquido; q.irrf += c.irrf;
          if (m.slice(0, 4) === anoHoje) { res.liquidoAno += c.liquido; res.irrfAno += c.irrf; }
        }
      } else {
        res.nAReceber++;
        if (c.falta) res.faltasAReceber++; else res.aReceber += c.liquido;
      }
      if (i.tipo === 'DIVIDENDO' && data) {
        if (classificar(i.ativo, null, opcoes.manual).classe === 'BDR') {
          if (!avisados[i.ativo]) { avisados[i.ativo] = true; avisos.push({ ativo: i.ativo, texto: i.ativo + ': dividendo de BDR tem origem no exterior e tributação própria. Ele fica fora do alerta de R$ 50 mil, e o site não calcula esse imposto: caso para contador.' }); }
        } else {
          var g = grupo(raizEmpresa(i.ativo), m);
          if (i.origem === 'REEMBOLSO') g.reembolso += c.bruto;
          else { g.dividendos += c.bruto; g.ativos[i.ativo] = true; }
        }
      }
    });
    (opcoes.bonificacoes || []).forEach(function (b) {
      var g = grupo(raizEmpresa(b.ativo), mes(b.data));
      g.ativos[b.ativo] = true;
      if (b.valor == null) { if (g.semCusto.indexOf(b.ativo) < 0) g.semCusto.push(b.ativo); }
      else g.capitalizacao += b.valor;
    });
    var alertas = [];
    Object.keys(grupos).forEach(function (k) {
      var g = grupos[k], total = r2(g.dividendos + g.capitalizacao), reemb = r2(g.reembolso);
      var nivel = total > LIMITE_DIVIDENDOS ? 'ALERTA' : r2(total + reemb) > LIMITE_DIVIDENDOS ? 'REEMBOLSO' : g.semCusto.length ? 'SEM_CUSTO' : null;
      if (!nivel) return;
      alertas.push({ raiz: g.raiz, mes: g.mes, nivel: nivel, dividendos: r2(g.dividendos), capitalizacao: r2(g.capitalizacao), total: total, reembolso: reemb,
        irrf10: nivel === 'ALERTA' ? r2(total * ALIQ_DIVIDENDOS) : null, ativos: Object.keys(g.ativos).sort(), semCusto: g.semCusto.slice().sort() });
    });
    alertas.sort(function (a, b) { return a.mes < b.mes ? 1 : a.mes > b.mes ? -1 : a.raiz < b.raiz ? -1 : 1; });
    var lista = Object.keys(meses).sort().reverse().map(function (m) {
      var q = meses[m], s = 0;
      ['DIVIDENDO', 'JCP', 'FII', 'ALUGUEL', 'REEMBOLSO'].forEach(function (col) { s += q[col]; q[col] = r2(q[col]); if (q._falta[col]) q[col] = null; });
      q.total = q.faltam ? null : r2(s); q.irrf = r2(q.irrf); delete q._falta; return q;
    });
    linhas.sort(function (a, b) {
      var da = a.item.pagamento || a.item.dataCom || '', db = b.item.pagamento || b.item.dataCom || '';
      return da < db ? 1 : da > db ? -1 : 0;
    });
    res.liquidoAno = res.faltasAno ? null : r2(res.liquidoAno); res.irrfAno = r2(res.irrfAno); res.aReceber = r2(res.aReceber);
    return { linhas: linhas, meses: lista, resumo: res, alertas: alertas, pendencias: pendencias, avisos: avisos };
  }
  /**
   * Estimados (decisão do Leo, 03/11/2026): cada pagamento dos últimos 12 meses se repete no mesmo mês do ano seguinte,
   * com o valor por ação da época e a posição de hoje. Nunca se soma aos confirmados. posicoes = saída de processar.
   */
  function estimarProventos(itens, posicoes, opcoes) {
    var hoje = (opcoes && opcoes.hoje) || '9999-12-31';
    var corte = (Number(hoje.slice(0, 4)) - 1) + hoje.slice(4);
    var anunciado = Object.create(null), semData = Object.create(null), comBase = Object.create(null), semPosicao = Object.create(null);
    var base = [];
    (itens || []).forEach(function (i) {
      if (i.tipo === 'ALUGUEL') return;
      if (!i.pagamento) { semData[i.ativo + '|' + i.tipo] = true; return; }
      if (i.pagamento > hoje) { anunciado[i.ativo + '|' + i.tipo + '|' + mes(i.pagamento)] = true; return; }
      if (i.pagamento > corte) base.push(i);
    });
    var linhas = [], meses = Object.create(null), substituidas = 0, total = 0, vistos = Object.create(null);
    base.forEach(function (i) {
      // Com parte das ações alugadas, o mesmo provento chega em dois lançamentos (empresa e reembolso): a posição de hoje já cobre os dois.
      var chave = i.ativo + '|' + i.tipo + '|' + i.pagamento + '|' + i.valorUnit;
      if (vistos[chave]) return; vistos[chave] = true;
      var p = posicoes && Object.prototype.hasOwnProperty.call(posicoes, i.ativo) ? posicoes[i.ativo] : null;
      if (!p || !(p.qtd > 0)) { semPosicao[i.ativo] = true; return; }
      comBase[i.ativo] = true;
      var alvo = (Number(i.pagamento.slice(0, 4)) + 1) + i.pagamento.slice(4), m = mes(alvo);
      if (anunciado[i.ativo + '|' + i.tipo + '|' + m]) { substituidas++; return; }
      var bruto = r2(p.qtd * i.valorUnit), irrf = i.tipo === 'JCP' ? r2(bruto * aliquotaJcp(alvo)) : 0, liq = r2(bruto - irrf);
      linhas.push({ ativo: i.ativo, tipo: i.tipo, mes: m, qtd: p.qtd, valorUnit: i.valorUnit, bruto: bruto, irrf: irrf, liquido: liq, anuncioSemData: !!semData[i.ativo + '|' + i.tipo],
        base: { pagamento: i.pagamento, valorUnit: i.valorUnit, qtd: i.qtd } });
      var q = meses[m] || (meses[m] = { mes: m, liquido: 0, n: 0 }); q.liquido += liq; q.n++; total += liq;
    });
    linhas.sort(function (a, b) { return a.mes < b.mes ? -1 : a.mes > b.mes ? 1 : a.ativo < b.ativo ? -1 : a.ativo > b.ativo ? 1 : 0; });
    var semBase = Object.keys(posicoes || {}).filter(function (a) {
      var p = posicoes[a]; return p && p.qtd > 0 && p.classe !== 'OPCAO' && p.classe !== 'DIREITO' && !comBase[a];
    }).sort();
    return { linhas: linhas, meses: Object.keys(meses).sort().map(function (m) { meses[m].liquido = r2(meses[m].liquido); return meses[m]; }), liquidoTotal: r2(total),
      semBase: semBase, semPosicao: Object.keys(semPosicao).sort(), substituidas: substituidas };
  }
  /** Quantidade no fim do dia (data-com): só pré-preenche o campo; o usuário confere. */
  function posicaoEm(lancamentos, ativo, data, opcoes) {
    var a = normalizarTicker(ativo);
    var r = processar((lancamentos || []).filter(function (l) { return l.data <= data; }), opcoes || {});
    return r.posicoes[a] && r.posicoes[a].qtd > 0 ? r.posicoes[a].qtd : 0;
  }

  /** Confere a posição do motor com a da B3/corretora: [{ ativo, qtd }] → divergências. */
  function conferirPosicao(posicoes, externa) {
    var dif = [], vistos = {};
    (externa || []).forEach(function (x) {
      var a = normalizarTicker(x.ativo); vistos[a] = true;
      var q = posicoes[a] ? posicoes[a].qtd : 0;
      if (Math.abs(q - x.qtd) > EPS) dif.push({ ativo: a, site: q, externa: x.qtd });
    });
    Object.keys(posicoes).forEach(function (a) { if (!vistos[a] && posicoes[a].qtd !== 0) dif.push({ ativo: a, site: posicoes[a].qtd, externa: 0 }); });
    return dif;
  }

  var API = { VERSAO: VERSAO, versaoRegras: '2026-11-03', CLASSES: CLASSES, NOME_CLASSE: NOME_CLASSE, EVENTOS: EVENTOS_SOC.concat(EVENTOS_OPCAO),
    processar: processar, apurar: apurar, vencimentoDarf: vencimentoDarf, painelIR: painelIR, movimentar: movimentar, classificar: classificar, normalizarTicker: normalizarTicker, vencimentoSugerido: vencimentoSugerido,
    categoria: categoria, naoRealizado: naoRealizado, avisoBackup: avisoBackup, conferirPosicao: conferirPosicao,
    aliquotaAluguel: aliquotaAluguel, aliquotaJcp: aliquotaJcp, raizEmpresa: raizEmpresa, calcularRendimento: calcularRendimento, painelRendimentos: painelRendimentos, estimarProventos: estimarProventos, posicaoEm: posicaoEm };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.MotorCarteira = Object.freeze(API);
})(typeof window !== 'undefined' ? window : this);
