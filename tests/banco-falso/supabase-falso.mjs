/**
 * tests/banco-falso/supabase-falso.mjs — o subconjunto do query builder
 * do supabase-js que os serviços deste projeto usam, sobre um arquivo
 * JSON. Cada operação relê e regrava o arquivo, para dois PROCESSOS
 * enxergarem o mesmo estado — é isso que faz dele um dublê de
 * durabilidade, não só de comportamento.
 *
 * Honra: filtros eq/in/is/not/lte/lt/like/or (com `and(...)` e
 * `in.(a,b)`), order/limit, select com count+head, single/maybeSingle,
 * insert/update/delete com `.select()` de retorno, e chave única por
 * tabela (`UNICAS`) devolvendo `error.code = '23505'`.
 *
 * Grosseiro de propósito: o que ele não entende, ele LANÇA — melhor um
 * teste que quebra alto do que um dublê que aprova o que não leu.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const ARQUIVO = process.env.BANCO_FALSO_ARQUIVO;
if (!ARQUIVO) throw new Error('BANCO_FALSO_ARQUIVO não definido');

const UNICAS = {
  outbox_notificacoes: [['chave_idempotencia'], ['id']],
  webhook_inbox: [['impressao_digital'], ['id']],
  clientes_asaas: [['ambiente', 'documento_hash']],
  contratantes: [['id']],
  cobrancas: [['id'], ['charge_id']]
};

function ler() {
  if (!existsSync(ARQUIVO)) return { tabelas: {} };
  return JSON.parse(readFileSync(ARQUIVO, 'utf8'));
}
function gravar(estado) { writeFileSync(ARQUIVO, JSON.stringify(estado, null, 1)); }

function valorDe(texto) {
  if (texto === 'null') return null;
  if (texto === 'true') return true;
  if (texto === 'false') return false;
  return texto;
}

function compara(a, op, b) {
  switch (op) {
    case 'eq': return a === b || String(a) === String(b);
    case 'neq': return !(a === b || String(a) === String(b));
    case 'lt': return a !== null && a !== undefined && String(a) < String(b);
    case 'lte': return a !== null && a !== undefined && String(a) <= String(b);
    case 'gt': return a !== null && a !== undefined && String(a) > String(b);
    case 'gte': return a !== null && a !== undefined && String(a) >= String(b);
    case 'is': return b === null ? (a === null || a === undefined) : a === b;
    case 'like': return new RegExp('^' + String(b).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$').test(String(a ?? ''));
    default: throw new Error(`operador não suportado: ${op}`);
  }
}

/** Parser mínimo da gramática de `.or()`: `a.eq.1,and(b.in.(x,y),c.lt.z)`. */
function parseOr(texto) {
  const itens = [];
  let nivel = 0; let atual = '';
  for (const c of texto) {
    if (c === '(') nivel += 1;
    if (c === ')') nivel -= 1;
    if (c === ',' && nivel === 0) { itens.push(atual); atual = ''; continue; }
    atual += c;
  }
  if (atual) itens.push(atual);
  return (linha) => itens.some((item) => avaliaItem(item, linha));
}
function avaliaItem(item, linha) {
  const m = item.match(/^(and|or)\((.*)\)$/);
  if (m) {
    const sub = parseOr(m[2]);
    if (m[1] === 'or') return sub(linha);
    // and: todos os itens
    const itens = []; let nivel = 0; let atual = '';
    for (const c of m[2]) { if (c === '(') nivel += 1; if (c === ')') nivel -= 1; if (c === ',' && nivel === 0) { itens.push(atual); atual = ''; continue; } atual += c; }
    if (atual) itens.push(atual);
    return itens.every((i) => avaliaItem(i, linha));
  }
  const mi = item.match(/^([\w.]+)\.in\.\((.*)\)$/);
  if (mi) return mi[2].split(',').map((v) => valorDe(v.trim())).some((v) => compara(linha[mi[1]], 'eq', v));
  const mo = item.match(/^([\w.]+)\.(\w+)\.(.*)$/);
  if (!mo) throw new Error(`filtro or não entendido: ${item}`);
  return compara(linha[mo[1]], mo[2], valorDe(mo[3]));
}

class Consulta {
  constructor(tabela) {
    this.tabela = tabela; this.filtros = []; this.ordem = null; this.teto = null;
    this.modo = 'select'; this.colunas = '*'; this.contar = false; this.soCabecalho = false; this.retornar = false; this.um = null; this.corpo = null;
  }
  select(colunas = '*', opcoes = {}) {
    if (this.modo === 'select') { this.colunas = colunas; this.contar = opcoes.count === 'exact'; this.soCabecalho = Boolean(opcoes.head); }
    else this.retornar = true;
    return this;
  }
  insert(corpo) { this.modo = 'insert'; this.corpo = corpo; return this; }
  update(corpo) { this.modo = 'update'; this.corpo = corpo; return this; }
  delete() { this.modo = 'delete'; return this; }
  eq(c, v) { this.filtros.push((l) => compara(l[c], 'eq', v)); return this; }
  neq(c, v) { this.filtros.push((l) => compara(l[c], 'neq', v)); return this; }
  lt(c, v) { this.filtros.push((l) => compara(l[c], 'lt', v)); return this; }
  lte(c, v) { this.filtros.push((l) => compara(l[c], 'lte', v)); return this; }
  gt(c, v) { this.filtros.push((l) => compara(l[c], 'gt', v)); return this; }
  gte(c, v) { this.filtros.push((l) => compara(l[c], 'gte', v)); return this; }
  is(c, v) { this.filtros.push((l) => compara(l[c], 'is', v)); return this; }
  like(c, v) { this.filtros.push((l) => compara(l[c], 'like', v)); return this; }
  in(c, vs) { this.filtros.push((l) => vs.some((v) => compara(l[c], 'eq', v))); return this; }
  not(c, op, v) { this.filtros.push((l) => !compara(l[c], op, v)); return this; }
  or(texto) { this.filtros.push(parseOr(texto)); return this; }
  order(c, { ascending = true } = {}) { this.ordem = { c, ascending }; return this; }
  limit(n) { this.teto = n; return this; }
  maybeSingle() { this.um = 'maybe'; return this; }
  single() { this.um = 'single'; return this; }

  projeta(linha) {
    if (this.colunas === '*' || this.colunas.includes('(')) return { ...linha };
    const saida = {};
    for (const c of this.colunas.split(',').map((s) => s.trim())) if (c in linha) saida[c] = linha[c];
    return saida;
  }
  executa() {
    const estado = ler();
    const linhas = estado.tabelas[this.tabela] ?? (estado.tabelas[this.tabela] = []);
    const casa = (l) => this.filtros.every((f) => f(l));
    let data = null; let error = null; let count = null;

    if (this.modo === 'insert') {
      const novas = (Array.isArray(this.corpo) ? this.corpo : [this.corpo]).map((c) => ({ id: randomUUID(), criado_em: new Date().toISOString(), ...c }));
      for (const nova of novas) {
        for (const chave of UNICAS[this.tabela] ?? []) {
          if (chave.every((k) => nova[k] !== undefined && nova[k] !== null) && linhas.some((l) => chave.every((k) => l[k] === nova[k]))) {
            return { data: null, error: { code: '23505', message: `duplicate key (${chave.join(',')})` }, count: null };
          }
        }
        linhas.push(nova);
      }
      data = this.retornar ? (this.um ? novas[0] : novas.map((l) => this.projeta(l))) : null;
    } else if (this.modo === 'update') {
      const alvo = linhas.filter(casa);
      for (const l of alvo) Object.assign(l, this.corpo);
      data = this.retornar ? alvo.map((l) => this.projeta(l)) : null;
    } else if (this.modo === 'delete') {
      const restantes = linhas.filter((l) => !casa(l));
      estado.tabelas[this.tabela] = restantes;
    } else {
      let sel = linhas.filter(casa);
      if (this.ordem) sel.sort((a, b) => (String(a[this.ordem.c]) < String(b[this.ordem.c]) ? -1 : 1) * (this.ordem.ascending ? 1 : -1));
      if (this.teto != null) sel = sel.slice(0, this.teto);
      if (this.contar) count = sel.length;
      data = this.soCabecalho ? null : sel.map((l) => this.projeta(l));
      if (this.um === 'maybe') data = data?.[0] ?? null;
      if (this.um === 'single') { if (!data || data.length !== 1) error = { code: 'PGRST116', message: 'esperava uma linha' }; data = data?.[0] ?? null; }
    }
    if (this.modo !== 'select') gravar(estado);
    return { data, error, count };
  }
  then(resolve, reject) {
    try { return Promise.resolve(this.executa()).then(resolve, reject); } catch (e) { return Promise.reject(e).then(resolve, reject); }
  }
}

/** `rpc` só para o que existe no banco de verdade e alguém precisa
 *  PROVAR que foi chamado — hoje, `registrar_erro` (o aviso ao
 *  operador). Guarda os argumentos numa tabela `erros` com o nome dos
 *  parâmetros sem o `p_`. Qualquer outra função LANÇA. */
function rpc(nome, args) {
  if (nome !== 'registrar_erro') return Promise.reject(new Error(`rpc não suportada no banco falso: ${nome}`));
  const estado = ler();
  const linha = Object.fromEntries(Object.entries(args ?? {}).map(([k, v]) => [k.replace(/^p_/, ''), v]));
  (estado.tabelas.erros ??= []).push({ id: randomUUID(), criado_em: new Date().toISOString(), ...linha });
  gravar(estado);
  return Promise.resolve({ data: null, error: null });
}

export const supabase = { from: (tabela) => new Consulta(tabela), rpc };
