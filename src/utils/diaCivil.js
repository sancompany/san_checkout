/**
 * SAN CHECKOUT — src/utils/diaCivil.js
 *
 * Dia civil de Brasília, decidido no servidor.
 *
 * ── Por que existe ──────────────────────────────────────────────────
 * A métrica de sucesso é "cobranças confirmadas por contratante, **por
 * dia**" (`docs/funcional.md` §9), e a prontidão operacional exige que
 * ela responda literalmente **"quantos ontem?"**. Até 16/09/2026 a rota
 * contava as últimas N×24 h, que é parecido e não é a mesma coisa: às
 * 10h da manhã, "últimas 24h" mistura metade de hoje com metade de
 * ontem, e num dia de pico a diferença aparece.
 *
 * ── O que foi MEDIDO dentro do contêiner de produção (16/09/2026) ────
 *   Node v22.23.2 (node:22-alpine)
 *   TZ do processo:        (não definida) → o processo roda em **UTC**
 *   Fuso nomeado:          FUNCIONA (ICU completo na imagem)
 *   `2026-09-17T02:30:00Z` → `2026-09-17` em UTC, `2026-09-16` em SP
 *
 * As duas linhas juntas são o motivo deste arquivo:
 *
 * 1. **O processo é UTC**, então `getDate()`, `getHours()` e
 *    `toLocaleDateString()` sem fuso explícito devolvem dia de UTC. Entre
 *    21h e meia-noite de Brasília isso já é o dia seguinte lá — três
 *    horas por dia em que "hoje" estaria errado.
 * 2. **O fuso nomeado funciona**, então dá para fazer certo sem chumbar
 *    `-03:00`. Chumbar offset é decidir hoje o que vale até a próxima
 *    mudança de regra de horário do país.
 *
 * ⚠️ Se um dia a imagem passar a ter ICU reduzido, `Intl` com fuso
 * nomeado cai para UTC **em silêncio** e a métrica fica errada sem
 * avisar. O autoteste no fim deste arquivo falha nesse caso — é a única
 * coisa que impede essa regressão de passar despercebida.
 */

export const FUSO = 'America/Sao_Paulo';

const FORMATO_DATA = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit'
});

const FORMATO_COMPLETO = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit'
});

/** `AAAA-MM-DD` do instante, no fuso de Brasília. */
export function dataCivil(instante = new Date()) {
  return FORMATO_DATA.format(instante instanceof Date ? instante : new Date(instante));
}

/**
 * Quantos minutos o fuso está à frente do UTC NAQUELE instante.
 *
 * Sai do próprio `Intl` em vez de tabela: se a regra de horário do país
 * mudar, o dado vem atualizado com o ICU e este código não muda.
 */
function minutosAFrenteDoUtc(instante) {
  const p = Object.fromEntries(
    FORMATO_COMPLETO.formatToParts(instante).map((x) => [x.type, x.value])
  );
  // `en-CA` com hour12:false pode devolver "24" para meia-noite.
  const hora = p.hour === '24' ? 0 : Number(p.hour);
  const comoSeFosseUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day), hora, Number(p.minute), Number(p.second)
  );
  return (comoSeFosseUtc - instante.getTime()) / 60000;
}

/**
 * O instante UTC em que o dia civil `AAAA-MM-DD` começa em Brasília.
 *
 * Refina uma vez de propósito: num dia de mudança de horário, o offset
 * da meia-noite pode não ser o do palpite. Hoje o Brasil não tem horário
 * de verão e a segunda passada não muda nada — ela existe para o dia em
 * que voltar a ter, não para agora.
 */
export function inicioDoDiaCivil(data) {
  const [ano, mes, dia] = String(data).split('-').map(Number);
  const palpite = Date.UTC(ano, mes - 1, dia, 0, 0, 0);

  const primeiro = minutosAFrenteDoUtc(new Date(palpite));
  let instante = palpite - primeiro * 60000;

  const segundo = minutosAFrenteDoUtc(new Date(instante));
  if (segundo !== primeiro) instante = palpite - segundo * 60000;

  return new Date(instante);
}

/** `AAAA-MM-DD` de hoje em Brasília. */
export function hojeCivil(agora = new Date()) {
  return dataCivil(agora);
}

/** O dia civil `n` dias antes de `data` (string `AAAA-MM-DD`). */
export function diaCivilAntes(data, n) {
  // Meio-dia como âncora: soma/subtração de dias em UTC nunca cruza a
  // fronteira do dia por causa do offset de 3 h.
  const [ano, mes, dia] = String(data).split('-').map(Number);
  return dataCivil(new Date(Date.UTC(ano, mes - 1, dia - n, 12, 0, 0)));
}

/**
 * A lista dos `dias` dias civis que terminam em hoje, do mais antigo ao
 * mais novo. `dias = 1` devolve só hoje; `dias = 2`, ontem e hoje.
 */
export function ultimosDiasCivis(dias, agora = new Date()) {
  const hoje = hojeCivil(agora);
  return Array.from({ length: dias }, (_, i) => diaCivilAntes(hoje, dias - 1 - i));
}

/* ------------------------------------------------------------------
   Autoteste — `node src/utils/diaCivil.js`
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('diaCivil.js')) {
  const { strict: assert } = await import('node:assert');

  let checagens = 0;
  const conferir = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

  /* --- 1. A GUARDA DO ICU ------------------------------------------
     Se a imagem passar a ter ICU reduzido, `Intl` com fuso nomeado cai
     para UTC em silêncio e toda a métrica fica errada sem avisar. Esta
     é a checagem que transforma esse silêncio em suíte vermelha.

     `02:30Z` é a faixa que prova: em UTC já é dia 17, em Brasília ainda
     é dia 16. */
  const madrugada = new Date('2026-09-17T02:30:00Z');
  conferir(
    dataCivil(madrugada) === '2026-09-16',
    `ICU sem fuso nomeado: 02:30Z devia ser 2026-09-16 em Brasília, deu ${dataCivil(madrugada)}. ` +
    'Se a imagem trocou para ICU reduzido, Intl caiu para UTC em silêncio.'
  );
  conferir(
    dataCivil(madrugada) !== new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(madrugada),
    'o dia civil de Brasília não pode ser igual ao de UTC neste instante — se for, o fuso não está sendo aplicado'
  );

  /* --- 2. a virada do dia, dos dois lados --------------------------
     23:59:59 de Brasília = 02:59:59Z do dia seguinte. */
  conferir(dataCivil(new Date('2026-09-17T02:59:59Z')) === '2026-09-16', 'último segundo do dia 16 em Brasília');
  conferir(dataCivil(new Date('2026-09-17T03:00:00Z')) === '2026-09-17', 'primeiro segundo do dia 17 em Brasília');

  /* --- 3. início do dia civil vira o instante UTC certo ------------- */
  const inicio = inicioDoDiaCivil('2026-09-16');
  conferir(inicio.toISOString() === '2026-09-16T03:00:00.000Z', `início do dia deu ${inicio.toISOString()}`);
  conferir(dataCivil(inicio) === '2026-09-16', 'o início do dia pertence ao próprio dia');
  conferir(
    dataCivil(new Date(inicio.getTime() - 1)) === '2026-09-15',
    'um milissegundo antes do início pertence ao dia anterior — é o que faz a janela não vazar'
  );

  /* --- 4. aritmética de dias não escorrega pelo offset -------------- */
  conferir(diaCivilAntes('2026-09-01', 1) === '2026-08-31', 'atravessa a virada de mês');
  conferir(diaCivilAntes('2026-01-01', 1) === '2025-12-31', 'atravessa a virada de ano');
  conferir(diaCivilAntes('2024-03-01', 1) === '2024-02-29', 'ano bissexto');
  conferir(diaCivilAntes('2026-09-16', 0) === '2026-09-16', 'zero dias antes é o próprio dia');

  /* --- 5. a lista de dias, que é o que a métrica consome ------------ */
  const tresDias = ultimosDiasCivis(3, new Date('2026-09-17T02:30:00Z'));
  conferir(
    JSON.stringify(tresDias) === JSON.stringify(['2026-09-14', '2026-09-15', '2026-09-16']),
    `lista inesperada: ${JSON.stringify(tresDias)}`
  );
  conferir(ultimosDiasCivis(1, madrugada).length === 1, 'dias = 1 devolve só hoje');
  conferir(ultimosDiasCivis(1, madrugada)[0] === '2026-09-16', 'e hoje é o dia civil de Brasília, não de UTC');

  /* --- 6. a série é contígua e sem repetição, em janela longa ------- */
  const trinta = ultimosDiasCivis(30, new Date('2026-03-15T12:00:00Z'));
  conferir(trinta.length === 30, 'trinta dias são trinta entradas');
  conferir(new Set(trinta).size === 30, 'sem dia repetido');
  for (let i = 1; i < trinta.length; i += 1) {
    const esperado = diaCivilAntes(trinta[i], 1);
    if (esperado !== trinta[i - 1]) assert.fail(`série furada entre ${trinta[i - 1]} e ${trinta[i]}`);
  }
  checagens += 1;

  console.log(`diaCivil: ${checagens} checagens OK`);
}
