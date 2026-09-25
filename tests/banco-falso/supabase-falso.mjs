/**
 * tests/banco-falso/supabase-falso.mjs — o subconjunto do query builder
 * do supabase-js que os serviços deste projeto usam, sobre um arquivo
 * JSON. Cada operação relê e regrava o arquivo, para dois PROCESSOS
 * enxergarem o mesmo estado — é isso que faz dele um dublê de
 * durabilidade, não só de comportamento.
 *
 * Honra: filtros eq/in/is/not/lte/lt/like/or (com `and(...)` e
 * `in.(a,b)`), order/limit, select com count+head, single/maybeSingle,
 * insert/update/delete/upsert com `.select()` de retorno, e chave única
 * por tabela (`UNICAS`) devolvendo `error.code = '23505'`.
 *
 * FALHA INJETADA: `estado.falhas = { 'tabela.operacao': n }` no arquivo
 * faz as próximas `n` operações daquele tipo devolverem `error` (como o
 * PostgREST devolve, sem lançar) — para provar que quem chama NÃO engole
 * o erro. O contador mora no arquivo, então vale entre processos.
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
  /* Os PARCIAIS também, com o predicado de produção (lidos de `pg_indexes`
     em 25/09/2026). Sem eles o dublê aceitava duas reservas pendentes do
     mesmo plano+documento, e nenhuma suíte exercitava de verdade o
     reaproveitamento da reserva de assinatura (NEW-02). */
  cobrancas: [
    ['id'], ['charge_id'], ['asaas_checkout_id'],
    { colunas: ['contratante_id', 'pedido_id', 'metodo_pagamento'], onde: (l) => l.status === 'pendente' && l.pedido_id != null },
    { colunas: ['contratante_id', 'plano_id', 'documento', 'metodo_pagamento'], onde: (l) => l.status === 'pendente' && l.plano_id != null && l.pedido_id == null }
  ]
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

/* Ordem como a do Postgres: número com número compara como NÚMERO
   (`5 < 30`); o resto — datas ISO, texto — como texto. A primeira versão
   comparava tudo como texto, e `'5' < '30'` é falso: a guarda "o valor
   estornado só sobe" não podia ser exercitada aqui (C1-08). */
const numero = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null);
function ordem(a, b) {
  const [x, y] = [numero(a), numero(b)];
  if (x !== null && y !== null) return x < y ? -1 : x > y ? 1 : 0;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
function compara(a, op, b) {
  const presente = a !== null && a !== undefined;
  switch (op) {
    case 'eq': return a === b || String(a) === String(b);
    case 'neq': return !(a === b || String(a) === String(b));
    case 'lt': return presente && ordem(a, b) < 0;
    case 'lte': return presente && ordem(a, b) <= 0;
    case 'gt': return presente && ordem(a, b) > 0;
    case 'gte': return presente && ordem(a, b) >= 0;
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
  /* `coluna.not.<op>.<valor>` nega o resto — a primeira versão lia
     `status.not.in.(…)` como a coluna `status.not`, que não existe, e
     avaliava falso calado (C1-12). Coluna é só `\w+`. */
  const mn = item.match(/^(\w+)\.not\.(.+)$/);
  if (mn) return !avaliaItem(`${mn[1]}.${mn[2]}`, linha);
  const mi = item.match(/^(\w+)\.in\.\((.*)\)$/);
  if (mi) return mi[2].split(',').map((v) => valorDe(v.trim())).some((v) => compara(linha[mi[1]], 'eq', v));
  const mo = item.match(/^(\w+)\.(\w+)\.(.*)$/);
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
    else { this.retornar = true; this.colunas = colunas; } // `update().select('id')` devolve só `id`, como no PostgREST
    return this;
  }
  insert(corpo) { this.modo = 'insert'; this.corpo = corpo; return this; }
  upsert(corpo) { this.modo = 'upsert'; this.corpo = corpo; return this; }
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

  /** `maybeSingle`/`single` valem para escrita com `select` também — o
   *  PostgREST devolve UM objeto (ou `null`), nunca a lista. O dublê
   *  devolvia a lista num `update().select().maybeSingle()`, e quem a
   *  espalhava num objeto via as chaves `0`, `1`… (SEC-016, 25/09/2026). */
  moldar(data, error) {
    if (!Array.isArray(data)) return { data, error };
    if (this.um === 'maybe') {
      if (data.length > 1) return { data: null, error: { code: 'PGRST116', message: 'mais de uma linha' } };
      return { data: data[0] ?? null, error };
    }
    if (this.um === 'single') {
      if (data.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'esperava uma linha' } };
      return { data: data[0], error };
    }
    return { data, error };
  }

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

    const chaveDaFalha = `${this.tabela}.${this.modo}`;
    /* `lancar`: o cliente LANÇA em vez de devolver `{ error }` — o que um
       bug de biblioteca ou um `TypeError` no nosso código faria. Serve para
       provar que handler que rejeita não derruba o `server.js` (C2-L5). */
    if (estado.lancar?.[chaveDaFalha] > 0) {
      estado.lancar[chaveDaFalha] -= 1;
      gravar(estado);
      throw new TypeError(`exceção injetada em ${chaveDaFalha}`);
    }
    if (estado.falhas?.[chaveDaFalha] > 0) {
      estado.falhas[chaveDaFalha] -= 1;
      gravar(estado);
      return { data: null, error: { code: 'XX000', message: `falha injetada em ${chaveDaFalha}` }, count: null };
    }

    if (this.modo === 'upsert') {
      const novas = Array.isArray(this.corpo) ? this.corpo : [this.corpo];
      for (const nova of novas) {
        const existente = linhas.find((l) => nova.id !== undefined && l.id === nova.id);
        if (existente) Object.assign(existente, nova);
        else linhas.push({ criado_em: new Date().toISOString(), ...nova });
      }
      data = this.retornar ? novas.map((l) => this.projeta(l)) : null;
    } else if (this.modo === 'insert') {
      const novas = (Array.isArray(this.corpo) ? this.corpo : [this.corpo]).map((c) => ({ id: randomUUID(), criado_em: new Date().toISOString(), ...c }));
      for (const nova of novas) {
        for (const indice of UNICAS[this.tabela] ?? []) {
          const chave = Array.isArray(indice) ? indice : indice.colunas;
          const onde = Array.isArray(indice) ? () => true : indice.onde;
          if (!onde({ status: 'pendente', ...nova })) continue;
          if (chave.every((k) => nova[k] !== undefined && nova[k] !== null)
            && linhas.some((l) => onde(l) && chave.every((k) => l[k] === nova[k]))) {
            return { data: null, error: { code: '23505', message: `duplicate key (${chave.join(',')})` }, count: null };
          }
        }
        linhas.push(nova);
      }
      data = this.retornar ? (this.um ? novas[0] : novas.map((l) => this.projeta(l))) : null;
    } else if (this.modo === 'update') {
      const alvo = linhas.filter(casa);
      /* `single`/`maybeSingle` numa escrita que casa MAIS de uma linha: o
         PostgREST responde erro e a transação volta — nada é gravado
         (C2-L2b). A primeira versão gravava e depois devolvia o erro. */
      if (this.um && this.retornar && alvo.length > 1) {
        return { data: null, error: { code: 'PGRST116', message: 'mais de uma linha' }, count: null };
      }
      /* Índice único vale no UPDATE também (C1-12): gravar num `charge_id`
         que outra linha já tem é `23505` no Postgres, e nada é escrito.
         A comparação é contra o estado FINAL de todas as linhas — duas
         linhas do mesmo update indo para a mesma chave também violam
         (C2-L3b). */
      const final = new Map(linhas.map((l) => [l, alvo.includes(l) ? { ...l, ...this.corpo } : l]));
      for (const l of alvo) {
        const depois = final.get(l);
        for (const indice of UNICAS[this.tabela] ?? []) {
          const chave = Array.isArray(indice) ? indice : indice.colunas;
          const onde = Array.isArray(indice) ? () => true : indice.onde;
          if (!onde(depois) || !chave.every((k) => depois[k] !== undefined && depois[k] !== null)) continue;
          // Só a violação que ESTE update introduz: chave mexida, ou a linha entrando na condição do índice parcial.
          const mexeu = chave.some((k) => k in this.corpo && this.corpo[k] !== l[k]) || !onde(l);
          if (!mexeu) continue;
          if ([...final.entries()].some(([o, fo]) => o !== l && onde(fo) && chave.every((k) => fo[k] === depois[k]))) {
            return { data: null, error: { code: '23505', message: `duplicate key (${chave.join(',')})` }, count: null };
          }
        }
      }
      for (const l of alvo) Object.assign(l, this.corpo);
      data = this.retornar ? alvo.map((l) => this.projeta(l)) : null;
      ({ data, error } = this.moldar(data, error));
    } else if (this.modo === 'delete') {
      /* `delete().select()` devolve as linhas APAGADAS, como no PostgREST —
         o dublê devolvia `null` sempre, e um delete condicional que
         confere quantas linhas saíram (SEC-025) não tinha como ser testado. */
      const apagadas = linhas.filter(casa);
      estado.tabelas[this.tabela] = linhas.filter((l) => !casa(l));
      data = this.retornar ? apagadas.map((l) => this.projeta(l)) : null;
      ({ data, error } = this.moldar(data, error));
    } else {
      let sel = linhas.filter(casa);
      if (this.ordem) sel.sort((a, b) => (String(a[this.ordem.c]) < String(b[this.ordem.c]) ? -1 : 1) * (this.ordem.ascending ? 1 : -1));
      if (this.teto != null) sel = sel.slice(0, this.teto);
      if (this.contar) count = sel.length;
      data = this.soCabecalho ? null : sel.map((l) => this.projeta(l));
      // `maybeSingle` com DUAS linhas é erro no PostgREST, não "a primeira" (C1-12).
      if (this.um) ({ data, error } = this.moldar(data, error));
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
