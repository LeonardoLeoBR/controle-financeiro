/*
 * Motor de renda fixa BR — funções puras, sem dependências.
 * Roda no navegador (window.MotorRF) e no Node (require).
 * Regras verificadas em 29/10/2026 — ver references/tributacao-renda-fixa.md.
 *
 * Convenções:
 *  - Taxas em decimal (14,9% a.a. = 0.149). % do CDI em decimal (110% = 1.10).
 *  - Datas como string ISO 'AAAA-MM-DD' ou Date.
 *  - Dias corridos (dc) para IR/IOF; dias úteis (du, base 252) para juros.
 *  - du entre datas: conta a data inicial, exclui a final (convenção ANBIMA).
 *  - Qualquer parâmetro ausente vira aviso em `avisos` e a linha não é calculada.
 *
 * v1.1.0 (F1, 30/10/2026): indexador CDI_MAIS (CDI + spread), custódia obrigatória no Tesouro,
 *  spread obrigatório no Tesouro Selic, opções de premissa editada (du, alíquota de IR) em simularAporte/simular e cdiEquilibrio().
 */
(function (root) {
  'use strict';

  var IOF_TABELA = [96, 93, 90, 86, 83, 80, 76, 73, 70, 66, 63, 60, 56, 53, 50,
    46, 43, 40, 36, 33, 30, 26, 23, 20, 16, 13, 10, 6, 3, 0];

  var ISENTOS_IR = ['LCI', 'LCA', 'CRI', 'CRA', 'DEB_INCENTIVADA', 'LCD', 'POUPANCA'];
  var COM_IOF = function (tipo) { return tipo !== 'POUPANCA'; };

  function toDate(d) {
    if (d instanceof Date) return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    var p = String(d).split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }
  function iso(d) { return toDate(d).toISOString().slice(0, 10); }
  function addDays(d, n) { var x = toDate(d); x.setUTCDate(x.getUTCDate() + n); return x; }

  function diasCorridos(inicio, fim) {
    return Math.round((toDate(fim) - toDate(inicio)) / 86400000);
  }

  function ehDiaUtil(d, feriadosSet) {
    var x = toDate(d), w = x.getUTCDay();
    return w !== 0 && w !== 6 && !feriadosSet.has(iso(x));
  }

  /** Dias úteis de inicio (inclusive) a fim (exclusive). feriados: array de 'AAAA-MM-DD'.
   *  v1.1.1: conta semanas inteiras e desconta os feriados em dia de semana do período, com custo fixo
   *  (antes era um passo por dia: prazos longos travavam a página). Resultado idêntico ao da contagem dia a dia. */
  function diasUteis(inicio, fim, feriados) {
    var d = toDate(inicio), f = toDate(fim);
    if (!(d < f)) return 0;
    var dias = Math.round((f - d) / 86400000), n = Math.floor(dias / 7) * 5, w = d.getUTCDay(), resto = dias % 7;
    for (var i = 0; i < resto; i++) { var wd = (w + i) % 7; if (wd !== 0 && wd !== 6) n++; }
    var a = iso(d), b = iso(f), vistos = {};
    (feriados || []).forEach(function (h) {
      if (h >= a && h < b && !vistos[h]) { vistos[h] = true; var x = toDate(h).getUTCDay(); if (x !== 0 && x !== 6) n--; }
    });
    return n;
  }

  function aliquotaIR(dc) {
    if (dc <= 180) return 0.225;
    if (dc <= 360) return 0.20;
    if (dc <= 720) return 0.175;
    return 0.15;
  }

  function aliquotaIOF(dc) {
    if (dc >= 30) return 0;
    if (dc < 1) return 1; // resgate no mesmo dia: todo o rendimento
    return IOF_TABELA[dc - 1] / 100;
  }

  function fatorCDI(cdiAA, pctCDI, du) {
    var diario = Math.pow(1 + cdiAA, 1 / 252) - 1;
    return Math.pow(1 + diario * pctCDI, du);
  }
  function fatorPre(taxaAA, du) { return Math.pow(1 + taxaAA, du / 252); }
  function fatorIPCA(ipcaAA, jurosRealAA, dc, du) {
    return Math.pow(1 + ipcaAA, dc / 365) * Math.pow(1 + jurosRealAA, du / 252);
  }

  /** Taxa equivalente tributada de uma taxa isenta, dado o prazo em dias corridos.
   *  aliq (opcional, v1.1): alíquota de IR editada pelo usuário no lugar da tabela regressiva. */
  function grossUp(taxaIsenta, dc, aliq) { return taxaIsenta / (1 - (aliq != null ? aliq : aliquotaIR(dc))); }

  /** Último dia útil de um mês (mes 1-12). */
  function ultimoDiaUtil(ano, mes, feriados) {
    var set = new Set(feriados || []);
    var d = new Date(Date.UTC(ano, mes, 0));
    while (!ehDiaUtil(d, set)) d = addDays(d, -1);
    return d;
  }

  /** Datas de come-cotas (último dia útil de maio e novembro) estritamente entre inicio e fim. */
  function datasComeCotas(inicio, fim, feriados) {
    var out = [], a = toDate(inicio).getUTCFullYear(), b = toDate(fim).getUTCFullYear();
    for (var y = a; y <= b; y++) {
      [5, 11].forEach(function (m) {
        var d = ultimoDiaUtil(y, m, feriados);
        if (d > toDate(inicio) && d < toDate(fim)) out.push(d);
      });
    }
    return out;
  }

  function faltando(obj, campos) {
    return campos.filter(function (c) { return obj[c] === undefined || obj[c] === null || obj[c] === ''; });
  }

  /**
   * Fator bruto diário médio do produto (para segmentar o período).
   * Retorna {fatorPorDU: fn(du, dc) , avisos: []}
   */
  function fatorProduto(produto, mercado) {
    var av = [];
    var ix = produto.indexador;
    if (ix === 'CDI') {
      faltando(produto, ['pctCDI']).forEach(function (c) { av.push('produto.' + c); });
      faltando(mercado, ['cdiAA']).forEach(function (c) { av.push('mercado.' + c); });
      return { av: av, f: function (du) { return fatorCDI(mercado.cdiAA, produto.pctCDI, du); } };
    }
    if (ix === 'CDI_MAIS') { // CDI + spread (ex.: debêntures, CRI/CRA "CDI + 1,5%")
      faltando(produto, ['spreadAA']).forEach(function (c) { av.push('produto.' + c); });
      faltando(mercado, ['cdiAA']).forEach(function (c) { av.push('mercado.' + c); });
      return { av: av, f: function (du) { return fatorCDI(mercado.cdiAA, 1, du) * fatorPre(produto.spreadAA, du); } };
    }
    if (ix === 'SELIC') { // Tesouro Selic ~ Selic over; spread opcional
      faltando(mercado, ['selicAA']).forEach(function (c) { av.push('mercado.' + c); });
      // v1.1: spread (ágio/deságio do título) é obrigatório; 0 precisa ser informado, nunca presumido.
      faltando(produto, ['spreadAA']).forEach(function (c) { av.push('produto.' + c + ' (0 se não houver)'); });
      var s = produto.spreadAA || 0;
      return { av: av, f: function (du) { return fatorPre(mercado.selicAA, du) * fatorPre(s, du); } };
    }
    if (ix === 'PRE') {
      faltando(produto, ['taxaAA']).forEach(function (c) { av.push('produto.' + c); });
      return { av: av, f: function (du) { return fatorPre(produto.taxaAA, du); } };
    }
    if (ix === 'IPCA') {
      faltando(produto, ['jurosRealAA']).forEach(function (c) { av.push('produto.' + c); });
      faltando(mercado, ['ipcaProjAA']).forEach(function (c) { av.push('mercado.' + c + ' (projeção, declarar fonte)'); });
      return { av: av, f: function (du, dc) { return fatorIPCA(mercado.ipcaProjAA, produto.jurosRealAA, dc, du); } };
    }
    av.push('produto.indexador desconhecido: ' + ix);
    return { av: av, f: null };
  }

  function poupancaFator(inicio, fim, mercado) {
    var av = faltando(mercado, ['selicMetaAA', 'trAM']).map(function (c) { return 'mercado.' + c; });
    if (av.length) return { av: av, fator: null, meses: 0 };
    var a = toDate(inicio), b = toDate(fim);
    var meses = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
    if (b.getUTCDate() < a.getUTCDate()) meses -= 1; // só rende no aniversário
    var mensal = mercado.selicMetaAA > 0.085
      ? 0.005 + mercado.trAM
      : Math.pow(1 + 0.7 * mercado.selicMetaAA, 1 / 12) - 1 + mercado.trAM;
    return { av: [], fator: Math.pow(1 + mensal, Math.max(meses, 0)), meses: meses };
  }

  /**
   * Simula UM aporte até o resgate. Retorna a "DRE" do aporte.
   * produto: {tipo:'CDB'|'LCI'|...|'FUNDO_RF_LP'|'FUNDO_RF_CP'|'TESOURO'|'POUPANCA',
   *           indexador:'CDI'|'PRE'|'IPCA'|'SELIC', pctCDI, taxaAA, jurosRealAA, spreadAA,
   *           taxaAdmAA, custodiaAA}
   * mercado: {cdiAA, selicAA, selicMetaAA, trAM, ipcaProjAA}
   */
  function simularAporte(valor, dataAplic, dataResgate, produto, mercado, feriados, opcoes) {
    opcoes = opcoes || {};
    var dc = diasCorridos(dataAplic, dataResgate);
    // opcoes.du: dias úteis informados pelo usuário (premissa editada). Só vale para o aporte inicial;
    // simular() repassa apenas para o primeiro fluxo.
    var du = opcoes.du != null ? opcoes.du : diasUteis(dataAplic, dataResgate, feriados);
    var avisos = [];
    var r = { valor: valor, dc: dc, du: du, rendBruto: null, iof: null, aliqIOF: null,
      ir: null, aliqIR: null, custos: 0, rendLiquido: null, final: null, avisos: avisos,
      notas: [] };

    var bruto;
    if (produto.tipo === 'TESOURO' && (produto.custodiaAA === undefined || produto.custodiaAA === null || produto.custodiaAA === '')) {
      avisos.push('produto.custodiaAA (taxa de custódia B3 vigente; 0 se isento)');
    }
    if (produto.tipo === 'POUPANCA') {
      var p = poupancaFator(dataAplic, dataResgate, mercado);
      avisos.push.apply(avisos, p.av);
      if (p.fator === null) return r;
      bruto = valor * p.fator;
      r.notas.push('Poupança: ' + p.meses + ' aniversário(s) completo(s).');
    } else {
      var fp = fatorProduto(produto, mercado);
      avisos.push.apply(avisos, fp.av);
      if (avisos.length || !fp.f) return r;
      var ehFundo = /^FUNDO_RF/.test(produto.tipo);
      if (!ehFundo) {
        bruto = valor * fp.f(du, dc);
      } else {
        // Fundo: fator diário constante, taxa de adm embutida e come-cotas em maio/novembro.
        if (produto.taxaAdmAA === undefined) avisos.push('produto.taxaAdmAA');
        if (avisos.length) return r;
        var aliqCC = produto.tipo === 'FUNDO_RF_CP' ? 0.20 : 0.15;
        var adm = function (d) { return Math.pow(1 - produto.taxaAdmAA, d / 252); };
        var marcos = datasComeCotas(dataAplic, dataResgate, feriados).concat([toDate(dataResgate)]);
        var v = valor, baseCC = valor, pago = 0, ant = toDate(dataAplic), duAcum = 0;
        marcos.forEach(function (m, i) {
          var duSeg = diasUteis(ant, m, feriados), dcSeg = diasCorridos(ant, m);
          v *= fp.f(duSeg, dcSeg) * adm(duSeg); duAcum += duSeg;
          if (i < marcos.length - 1) {
            var imp = Math.max(0, v - baseCC) * aliqCC;
            v -= imp; pago += imp; baseCC = v;
          }
          ant = m;
        });
        var ganhoTotal = v + pago - valor;
        var aliqFinal = produto.tipo === 'FUNDO_RF_CP' ? (dc <= 180 ? 0.225 : 0.20) : aliquotaIR(dc);
        var aliqIOFf = aliquotaIOF(dc);
        var iofF = Math.max(0, ganhoTotal) * aliqIOFf;
        var irTotal = Math.max(0, ganhoTotal - iofF) * aliqFinal;
        var complemento = Math.max(0, irTotal - pago);
        r.rendBruto = ganhoTotal; r.aliqIOF = aliqIOFf; r.iof = iofF;
        r.aliqIR = aliqFinal; r.ir = pago + complemento;
        r.rendLiquido = ganhoTotal - iofF - r.ir;
        r.final = valor + r.rendLiquido;
        r.notas.push('Come-cotas pago no período: ' + pago.toFixed(2) + ' (' + (marcos.length - 1) + ' evento(s)).');
        r.notas.push('Taxa de administração já descontada do rendimento bruto (embutida na cota).');
        r.notas.push('Aproximação: rentabilidade bruta diária constante no período.');
        return r;
      }
    }

    var rend = bruto - valor;
    var custos = 0;
    if (produto.custodiaAA) { // ex.: custódia B3 no Tesouro — informar valor vigente
      custos = valor * (Math.pow(1 + produto.custodiaAA, dc / 365) - 1);
      r.notas.push('Custódia aproximada pró-rata sobre o valor aplicado.');
    }
    var isento = ISENTOS_IR.indexOf(produto.tipo) >= 0;
    var aliqIOF = COM_IOF(produto.tipo) ? aliquotaIOF(dc) : 0;
    var iof = Math.max(0, rend) * aliqIOF;
    var aliqIR = isento ? 0 : (opcoes.aliqIR != null ? opcoes.aliqIR : aliquotaIR(dc));
    var ir = Math.max(0, rend - iof) * aliqIR;

    r.rendBruto = rend; r.aliqIOF = aliqIOF; r.iof = iof; r.aliqIR = aliqIR; r.ir = ir;
    r.custos = custos; r.rendLiquido = rend - iof - ir - custos; r.final = valor + r.rendLiquido;
    if (isento) r.notas.push('Isento de IR para pessoa física.');
    return r;
  }

  /**
   * Simula vários aportes (cada um com seu prazo e sua alíquota — regra PEPS).
   * fluxos: [{data:'AAAA-MM-DD', valor: 1000}, ...]
   */
  function simular(fluxos, dataResgate, produto, mercado, feriados, opcoes) {
    opcoes = opcoes || {};
    var partes = fluxos.map(function (f, i) {
      var op = { aliqIR: opcoes.aliqIR, du: i === 0 ? opcoes.du : null };
      return simularAporte(f.valor, f.data, dataResgate, produto, mercado, feriados, op);
    });
    var soma = function (k) {
      return partes.some(function (p) { return p[k] === null; }) ? null
        : partes.reduce(function (s, p) { return s + p[k]; }, 0);
    };
    var avisos = [];
    partes.forEach(function (p) { p.avisos.forEach(function (a) { if (avisos.indexOf(a) < 0) avisos.push(a); }); });
    var capital = fluxos.reduce(function (s, f) { return s + f.valor; }, 0);
    var res = {
      capital: capital, rendBruto: soma('rendBruto'), iof: soma('iof'), ir: soma('ir'),
      custos: soma('custos'), rendLiquido: soma('rendLiquido'), final: soma('final'),
      avisos: avisos, partes: partes
    };
    if (res.final !== null) {
      var cf = fluxos.map(function (f) { return { data: f.data, valor: -f.valor }; });
      cf.push({ data: iso(dataResgate), valor: res.final });
      res.tirAA = tir(cf);
    }
    return res;
  }

  /** VPL com taxa anual, fluxos datados (dias corridos/365). */
  function vpl(taxaAA, fluxos) {
    var t0 = toDate(fluxos[0].data);
    return fluxos.reduce(function (s, f) {
      return s + f.valor / Math.pow(1 + taxaAA, diasCorridos(t0, f.data) / 365);
    }, 0);
  }

  /** TIR anual (XIRR) por bisseção. Retorna null se não houver troca de sinal. */
  function tir(fluxos) {
    var lo = -0.99, hi = 10, flo = vpl(lo, fluxos), fhi = vpl(hi, fluxos);
    if (flo * fhi > 0) return null;
    for (var i = 0; i < 200; i++) {
      var mid = (lo + hi) / 2, fm = vpl(mid, fluxos);
      if (Math.abs(fm) < 1e-9) return mid;
      if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  }

  /** Retorno real pela equação de Fisher. */
  function retornoReal(nominal, inflacao) { return (1 + nominal) / (1 + inflacao) - 1; }

  /** Converte rentabilidade do período em taxa anual (base 252 ou 365). */
  function anualizar(rentPeriodo, dias, base) {
    return Math.pow(1 + rentPeriodo, (base || 252) / dias) - 1;
  }

  /** % do CDI líquido equivalente: que % do CDI um CDB tributado precisaria pagar para empatar. */
  function pctCDIEquivalente(rendLiqPeriodo, valor, cdiAA, du, dc) {
    var alvo = 1 + rendLiqPeriodo / valor;
    var lo = 0, hi = 5;
    for (var i = 0; i < 100; i++) {
      var mid = (lo + hi) / 2;
      var rend = fatorCDI(cdiAA, mid, du) - 1;
      var liq = 1 + rend * (1 - aliquotaIOF(dc)) * (1 - aliquotaIR(dc));
      if (liq < alvo) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /**
   * CDI médio (a.a.) no qual o produto pós-fixado empata em patrimônio final com um valor-alvo.
   * Útil para comparar pós × pré/IPCA: "o CDB 102% do CDI empata com o pré se o CDI médio for X%".
   * Retorna null se não houver empate entre 0% e 100% a.a. ou se faltar dado.
   */
  function cdiEquilibrio(alvoFinal, fluxos, dataResgate, produto, mercado, feriados, opcoes) {
    var finalCom = function (cdi) {
      var m = {}; for (var k in mercado) m[k] = mercado[k];
      m.cdiAA = cdi; if (produto.indexador === 'SELIC') m.selicAA = cdi;
      return simular(fluxos, dataResgate, produto, m, feriados, opcoes).final;
    };
    var lo = 0, hi = 1, flo = finalCom(lo), fhi = finalCom(hi);
    if (flo === null || fhi === null || (flo - alvoFinal) * (fhi - alvoFinal) > 0) return null;
    for (var i = 0; i < 80; i++) {
      var mid = (lo + hi) / 2, fm = finalCom(mid);
      if ((flo - alvoFinal) * (fm - alvoFinal) <= 0) { hi = mid; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  }

  var API = {
    versao: '1.1.1',
    versaoRegras: '2026-10-29',
    diasCorridos: diasCorridos, diasUteis: diasUteis, aliquotaIR: aliquotaIR,
    aliquotaIOF: aliquotaIOF, fatorCDI: fatorCDI, fatorPre: fatorPre, fatorIPCA: fatorIPCA,
    grossUp: grossUp, datasComeCotas: datasComeCotas, simularAporte: simularAporte,
    simular: simular, vpl: vpl, tir: tir, retornoReal: retornoReal, anualizar: anualizar,
    pctCDIEquivalente: pctCDIEquivalente, cdiEquilibrio: cdiEquilibrio, ISENTOS_IR: ISENTOS_IR
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.MotorRF = API;
})(typeof window !== 'undefined' ? window : this);
