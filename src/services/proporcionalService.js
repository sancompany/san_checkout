/**
 * SAN CHECKOUT v2 — src/services/proporcionalService.js
 *
 * O cálculo do acerto proporcional de uma troca de plano. Função pura:
 * não fala com a Asaas, não escreve no banco, não conhece requisição.
 * Quem cobra e quem grava é outro módulo — aqui só mora a aritmética,
 * porque é ela que precisa estar indiscutível.
 *
 * ── As sete regras, e de onde cada uma vem ──────────────────────────
 * Decisões do dono em 17/09/2026, respondendo às sete perguntas que o
 * desenho tinha em aberto (`docs/proximas-versoes.md`):
 *
 *  1. **Acerto abaixo do piso de R$ 5,00: ABSORVE.** A Asaas recusa
 *     cobrança menor que isso (medido: `400 invalid_value`), e a saída
 *     escolhida é não cobrar — nunca cobrar mais do que o devido só
 *     para caber no piso.
 *  2. **Acerto negativo ou zero: não cobra e NÃO DEVOLVE.**
 *  3. **Assinante com cobrança pendente não paga: recusa a troca.** Não
 *     existe crédito de período que não foi pago. (Quem confere isso é
 *     o chamador; aqui a função só exige o valor PAGO.)
 *  4. **Crédito NÃO acumula.** Cada troca recalcula sobre os dias que
 *     restam agora, e o crédito da troca anterior morre ali. Palavras
 *     do dono: "cada troca zera o crédito anterior e sobra somente o
 *     crédito restante dos dias, não junta nunca". É por isso que a
 *     função recebe `valorPagoDoPeriodo` e não um saldo: saldo
 *     guardado é o que permitiria trocar de plano para ganhar crédito.
 *  5. **Mês comercial de 30 dias** — e por consequência ano de 360.
 *  6. **Só existe acerto para CIMA.** Rebaixamento não gera cobrança
 *     nem devolução: o preço novo passa a valer na próxima data de
 *     vencimento. Rebaixamento nem chega aqui.
 *  7. **Avisar o assinante da mudança de preço é obrigação do
 *     contratante** (e-mail e aviso no site dele). O checkout não fala
 *     com o pagador — `docs/funcional.md` RN-35.
 *
 * ── Por que a fórmula proporcionaliza os DOIS lados ─────────────────
 * "Cobrar a diferença entre os planos" só funciona quando os dois têm o
 * mesmo ciclo. Entre ciclos diferentes ela dá absurdo: de um mensal de
 * R$ 100 para um trimestral de R$ 270, a "diferença" seria R$ 170
 * cobrados por 15 dias de um plano que custa R$ 90/mês. Um plano mais
 * caro no total pode ser **mais barato por dia**.
 *
 * Então: credita-se o não usado do que foi pago, debita-se o que o
 * plano novo custaria naqueles mesmos dias, e cobra-se a diferença.
 */

/** Dias por ciclo, em mês comercial de 30 dias (decisão 5 do dono).
 *  Os sete ciclos são os que a Asaas aceita (`API.md` §7.1). */
const DIAS_DO_CICLO = {
  WEEKLY: 7,
  BIWEEKLY: 14,
  MONTHLY: 30,
  BIMONTHLY: 60,
  QUARTERLY: 90,
  SEMIANNUALLY: 180,
  YEARLY: 360
};

/** Quantos meses de CALENDÁRIO cada ciclo mensal ocupa. Semanal e
 *  quinzenal ficam de fora porque são contados em dias, e neles o
 *  calendário e o comercial coincidem (7 e 14). */
const MESES_DO_CICLO = {
  MONTHLY: 1,
  BIMONTHLY: 2,
  QUARTERLY: 3,
  SEMIANNUALLY: 6,
  YEARLY: 12
};

/**
 * A maior duração que um período do ciclo pode ter no CALENDÁRIO, em
 * dias. É a régua do "dado incoerente".
 *
 * Por que ela existe (achado em 25/09/2026, com a assinatura anual real
 * `sub_39mjscz7vl2jwx7g`): a data de vencimento é civil, e o ciclo
 * comercial é de 360 dias. Um anual pago hoje vence daqui a 365 (ou 366)
 * dias civis. A guarda antiga comparava os dias CIVIS restantes com o
 * ciclo COMERCIAL, e recusava toda troca nos primeiros dias de todo ciclo
 * mensal, trimestral, semestral e anual: 365 > 360, 31 > 30, 92 > 90,
 * 184 > 180.
 *
 * A comparação certa é civil com civil: nenhum período de N meses
 * passa desta duração, então o que passar dela é mesmo dado errado. A
 * régua é calculada, e não escrita à mão, varrendo quatro anos
 * (um bissexto incluído) a partir de todo início de mês. De qualquer
 * dia até o mesmo dia N meses depois, a duração é a soma dos meses
 * atravessados, então os inícios de mês bastam para achar o máximo.
 */
const DURACAO_CIVIL_MAXIMA = Object.fromEntries(
  Object.entries(DIAS_DO_CICLO).map(([ciclo, dias]) => {
    const meses = MESES_DO_CICLO[ciclo];
    if (!meses) return [ciclo, dias];
    let maior = 0;
    for (let ano = 2024; ano < 2028; ano += 1) {
      for (let mes = 0; mes < 12; mes += 1) {
        maior = Math.max(maior, (Date.UTC(ano, mes + meses, 1) - Date.UTC(ano, mes, 1)) / 86400000);
      }
    }
    return [ciclo, maior];
  })
);

/** Piso da Asaas por cobrança, medido nos dois meios em 17/09/2026:
 *  "O valor mínimo para cobranças via cartão de crédito é R$ 5,00" e a
 *  mesma frase para boleto. Não é número nosso — é recusa do provedor. */
const PISO_DE_COBRANCA = 5;

const centavos = (n) => Math.round(n * 100) / 100;

/**
 * Dias entre hoje e o vencimento, sem hora e sem fuso: as duas datas
 * chegam como `AAAA-MM-DD` e a conta é de dias civis. Usar `Date` com
 * hora aqui abriria a mesma classe de erro que o dia civil da métrica
 * já pagou (`docs/erros/` de 16/09, o processo roda em UTC).
 */
export function diasAte(vencimento, hoje) {
  const [a1, m1, d1] = String(vencimento).split('-').map(Number);
  const [a2, m2, d2] = String(hoje).split('-').map(Number);
  if (!a1 || !m1 || !d1 || !a2 || !m2 || !d2) return null;
  const fim = Date.UTC(a1, m1 - 1, d1);
  const agora = Date.UTC(a2, m2 - 1, d2);
  return Math.round((fim - agora) / 86400000);
}

/**
 * O acerto de uma troca de plano.
 *
 * @param {object} p
 * @param {number} p.valorPagoDoPeriodo — o que o assinante PAGOU pelo
 *   período em curso. Não é o `valor` da assinatura: se alguém alterou
 *   o valor sem cobrar, o que vale é o que entrou (regra 4).
 * @param {string} p.cicloAtual — um dos sete de `DIAS_DO_CICLO`
 * @param {number} p.valorDoPlanoNovo
 * @param {string} p.cicloNovo
 * @param {string} p.vencimentoAtual — `AAAA-MM-DD`, a data da próxima
 *   cobrança que já está marcada. A Asaas NÃO move essa data quando o
 *   ciclo muda (medido em 17/09), e o desenho aproveita isso: o acerto
 *   cobre até ali, e o plano novo inteiro entra nela.
 * @param {string} p.hoje — `AAAA-MM-DD`
 * @returns {{cobra: boolean, acerto: number, credito: number, debito: number,
 *   diasRestantes: number, motivo: string, dadoIncoerente?: true}}
 *
 * `cobra: false` tem dois significados que NÃO podem se confundir no
 * caminho do dinheiro, e é por isso que `dadoIncoerente` existe:
 *   - **não é devido** (rebaixamento, acerto abaixo do piso, vencimento
 *     hoje) → a troca segue, sem cobrar. `dadoIncoerente` ausente.
 *   - **eu não sei calcular** (ciclo fora da lista, data impossível,
 *     dias restantes maiores que o ciclo) → `dadoIncoerente: true`, e
 *     quem chama RECUSA a troca. Tratar isto como "não é devido" daria
 *     de graça uma troca que ninguém conferiu.
 */
export function calcularAcertoDeTroca({
  valorPagoDoPeriodo,
  cicloAtual,
  valorDoPlanoNovo,
  cicloNovo,
  vencimentoAtual,
  hoje
}) {
  const diasAtual = DIAS_DO_CICLO[cicloAtual];
  const diasNovo = DIAS_DO_CICLO[cicloNovo];

  /* Ciclo desconhecido não vira palpite: a lista é fechada (lição nº 19
     do catálogo — conjunto enumerado pela metade), e errar aqui cobra
     valor errado de gente real. */
  if (!diasAtual || !diasNovo) {
    return {
      cobra: false, dadoIncoerente: true, acerto: 0, credito: 0, debito: 0, diasRestantes: 0,
      motivo: `ciclo desconhecido: ${!diasAtual ? cicloAtual : cicloNovo}`
    };
  }

  if (!(valorPagoDoPeriodo > 0) || !(valorDoPlanoNovo > 0)) {
    return {
      cobra: false, dadoIncoerente: true, acerto: 0, credito: 0, debito: 0, diasRestantes: 0,
      motivo: 'valor não utilizável'
    };
  }

  const dias = diasAte(vencimentoAtual, hoje);
  if (dias === null) {
    return { cobra: false, dadoIncoerente: true, acerto: 0, credito: 0, debito: 0, diasRestantes: 0, motivo: 'data não utilizável' };
  }

  /* Vencimento hoje ou no passado: não há período restante para
     proporcionalizar. O plano novo entra no vencimento, sem acerto. */
  if (dias <= 0) {
    return { cobra: false, acerto: 0, credito: 0, debito: 0, diasRestantes: 0, motivo: 'sem dias restantes' };
  }

  /* Mais dias restantes que o período mais longo que o ciclo pode ter no
     calendário é dado incoerente (data futura demais, ou ciclo errado no
     registro). Não inventa: recusa, e quem chamou decide. Cobrar sobre
     isso daria acerto inflado. A régua é CIVIL, porque `dias` é civil;
     compará-lo com o ciclo comercial recusava troca legítima
     (`DURACAO_CIVIL_MAXIMA`). */
  if (dias > DURACAO_CIVIL_MAXIMA[cicloAtual]) {
    return {
      cobra: false, dadoIncoerente: true, acerto: 0, credito: 0, debito: 0, diasRestantes: dias,
      motivo: `dias restantes (${dias}) maiores que o ciclo atual (${DURACAO_CIVIL_MAXIMA[cicloAtual]} dias no calendário)`
    };
  }

  /* Dentro do período, os dias restantes entram na conta em dias
     COMERCIAIS, e nunca mais que o ciclo inteiro: os dias em que o
     calendário excede o ciclo comercial (os 5 ou 6 de um ano, o 31º de um
     mês) contam como período ainda não usado, e o crédito para no que foi
     pago. Do 360º dia civil restante para baixo, nada muda. */
  const diasComerciais = Math.min(dias, diasAtual);

  const credito = centavos(valorPagoDoPeriodo * (diasComerciais / diasAtual));
  const debito = centavos(valorDoPlanoNovo * (diasComerciais / diasNovo));
  const acerto = centavos(debito - credito);

  /* Regra 2: para baixo não devolve. */
  if (acerto <= 0) {
    return { cobra: false, acerto, credito, debito, diasRestantes: diasComerciais, motivo: 'sem acerto a cobrar' };
  }

  /* Regra 1: abaixo do piso da Asaas, absorve. Cobrar R$ 5,00 no lugar
     de R$ 2,30 seria cobrar mais do que o devido para caber na régua do
     provedor — e a régua é dele, não do assinante. */
  if (acerto < PISO_DE_COBRANCA) {
    return {
      cobra: false, acerto, credito, debito, diasRestantes: diasComerciais,
      motivo: `absorvido: acerto de R$ ${acerto.toFixed(2)} abaixo do piso de R$ ${PISO_DE_COBRANCA},00`
    };
  }

  return { cobra: true, acerto, credito, debito, diasRestantes: diasComerciais, motivo: 'cobra o acerto' };
}

export { DIAS_DO_CICLO, PISO_DE_COBRANCA };

/* ------------------------------------------------------------------
   Autoteste — `node src/services/proporcionalService.js`
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('proporcionalService.js')) {
  const { strict: assert } = await import('node:assert');
  let checagens = 0;
  const conferir = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

  const base = { vencimentoAtual: '2026-10-10', hoje: '2026-09-25' }; // 15 dias

  /* --- 1. os três exemplos que o dono viu, agora com mês de 30 ------ */
  const mensalCaro = calcularAcertoDeTroca({
    ...base, valorPagoDoPeriodo: 100, cicloAtual: 'MONTHLY',
    valorDoPlanoNovo: 160, cicloNovo: 'MONTHLY'
  });
  conferir(mensalCaro.diasRestantes === 15, `15 dias restantes, veio ${mensalCaro.diasRestantes}`);
  conferir(mensalCaro.credito === 50, `crédito 50, veio ${mensalCaro.credito}`);
  conferir(mensalCaro.debito === 80, `débito 80, veio ${mensalCaro.debito}`);
  conferir(mensalCaro.acerto === 30 && mensalCaro.cobra, `acerto 30 e cobra, veio ${mensalCaro.acerto}/${mensalCaro.cobra}`);

  /* O trimestral mais caro no TOTAL e mais barato por DIA: não cobra.
     É o caso que derruba a fórmula ingênua da "diferença entre planos",
     que cobraria R$ 170 por 15 dias. */
  const trimestral = calcularAcertoDeTroca({
    ...base, valorPagoDoPeriodo: 100, cicloAtual: 'MONTHLY',
    valorDoPlanoNovo: 270, cicloNovo: 'QUARTERLY'
  });
  conferir(trimestral.debito === 45, `débito do trimestral 45, veio ${trimestral.debito}`);
  conferir(!trimestral.cobra && trimestral.acerto === -5, `não cobra e acerto -5, veio ${trimestral.acerto}`);

  /* Anual de R$ 2.400 com ano COMERCIAL de 360 (decisão 5): 2400×15/360
     = 100, menos 50 de crédito = 50. Com 365 dias daria 48,63 — a
     decisão do dono muda o número, e é por isso que ela está no código
     e não na minha memória. */
  const anual = calcularAcertoDeTroca({
    ...base, valorPagoDoPeriodo: 100, cicloAtual: 'MONTHLY',
    valorDoPlanoNovo: 2400, cicloNovo: 'YEARLY'
  });
  conferir(anual.debito === 100, `débito do anual 100 (ano de 360), veio ${anual.debito}`);
  conferir(anual.cobra && anual.acerto === 50, `acerto 50, veio ${anual.acerto}`);

  /* --- 2. regra 1: abaixo do piso, ABSORVE ------------------------- */
  /* 15 dias de mensal: de R$ 100 para R$ 108 dá acerto de R$ 4,00. */
  const perto = calcularAcertoDeTroca({
    ...base, valorPagoDoPeriodo: 100, cicloAtual: 'MONTHLY',
    valorDoPlanoNovo: 108, cicloNovo: 'MONTHLY'
  });
  conferir(perto.acerto === 4, `acerto de 4,00, veio ${perto.acerto}`);
  conferir(!perto.cobra, 'acerto de R$ 4,00 não é cobrado — absorve');
  conferir(/absorvido/.test(perto.motivo), `o motivo diz absorvido, veio "${perto.motivo}"`);

  /* Controle positivo do piso: R$ 5,00 exato COBRA. Sem este par, um
     "não cobra" acima poderia ser um guarda que recusa tudo. */
  const exato = calcularAcertoDeTroca({
    ...base, valorPagoDoPeriodo: 100, cicloAtual: 'MONTHLY',
    valorDoPlanoNovo: 110, cicloNovo: 'MONTHLY'
  });
  conferir(exato.acerto === 5, `acerto de 5,00 exato, veio ${exato.acerto}`);
  conferir(exato.cobra, 'R$ 5,00 exato É cobrado — o piso é "menor que", não "menor ou igual"');

  /* --- 3. regra 2: para baixo não devolve -------------------------- */
  const barato = calcularAcertoDeTroca({
    ...base, valorPagoDoPeriodo: 100, cicloAtual: 'MONTHLY',
    valorDoPlanoNovo: 60, cicloNovo: 'MONTHLY'
  });
  conferir(!barato.cobra, 'rebaixamento não cobra');
  conferir(barato.acerto < 0, 'e o acerto é negativo, que é o sinal de que não se devolve nada');

  /* --- 4. regra 4: crédito NÃO acumula ----------------------------- */
  /* Troca 1: 100 → 160 no dia 25 (15 dias), cobra 30.
     Troca 2, cinco dias depois (10 dias restantes): o crédito é do que
     foi PAGO no período (100), não do valor novo da assinatura (160) e
     nem de saldo nenhum. */
  const segunda = calcularAcertoDeTroca({
    valorPagoDoPeriodo: 100, cicloAtual: 'MONTHLY',
    valorDoPlanoNovo: 200, cicloNovo: 'MONTHLY',
    vencimentoAtual: '2026-10-10', hoje: '2026-09-30'
  });
  conferir(segunda.diasRestantes === 10, `10 dias na segunda troca, veio ${segunda.diasRestantes}`);
  conferir(segunda.credito === centavos(100 * 10 / 30), 'o crédito da 2ª troca sai do valor PAGO, não do valor vigente');
  conferir(segunda.debito === centavos(200 * 10 / 30), 'e o débito é do plano novo nos dias que restam');
  conferir(
    segunda.acerto === centavos(segunda.debito - segunda.credito),
    'nada de saldo anterior entra na conta — não acumula'
  );

  /* --- 5. as bordas de data --------------------------------------- */
  const hojeVence = calcularAcertoDeTroca({
    valorPagoDoPeriodo: 100, cicloAtual: 'MONTHLY', valorDoPlanoNovo: 300, cicloNovo: 'MONTHLY',
    vencimentoAtual: '2026-09-25', hoje: '2026-09-25'
  });
  conferir(!hojeVence.cobra && /sem dias/.test(hojeVence.motivo), 'vencimento hoje: sem acerto');

  const passado = calcularAcertoDeTroca({
    valorPagoDoPeriodo: 100, cicloAtual: 'MONTHLY', valorDoPlanoNovo: 300, cicloNovo: 'MONTHLY',
    vencimentoAtual: '2026-09-20', hoje: '2026-09-25'
  });
  conferir(!passado.cobra, 'vencimento no passado não vira acerto negativo de dias');

  const longe = calcularAcertoDeTroca({
    valorPagoDoPeriodo: 100, cicloAtual: 'MONTHLY', valorDoPlanoNovo: 300, cicloNovo: 'MONTHLY',
    vencimentoAtual: '2027-10-10', hoje: '2026-09-25'
  });
  conferir(!longe.cobra && /maiores que o ciclo/.test(longe.motivo), 'dias restantes maiores que o ciclo: recusa em vez de inflar');

  /* --- 6. entrada ruim não vira cobrança -------------------------- */
  conferir(!calcularAcertoDeTroca({ ...base, valorPagoDoPeriodo: 100, cicloAtual: 'DECADAL', valorDoPlanoNovo: 200, cicloNovo: 'MONTHLY' }).cobra, 'ciclo inventado não cobra');
  conferir(!calcularAcertoDeTroca({ ...base, valorPagoDoPeriodo: 0, cicloAtual: 'MONTHLY', valorDoPlanoNovo: 200, cicloNovo: 'MONTHLY' }).cobra, 'valor pago zero não cobra');
  conferir(!calcularAcertoDeTroca({ ...base, valorPagoDoPeriodo: 100, cicloAtual: 'MONTHLY', valorDoPlanoNovo: null, cicloNovo: 'MONTHLY' }).cobra, 'valor novo nulo não cobra');
  conferir(
    !calcularAcertoDeTroca({ valorPagoDoPeriodo: 100, cicloAtual: 'MONTHLY', valorDoPlanoNovo: 200, cicloNovo: 'MONTHLY', vencimentoAtual: 'amanhã', hoje: '2026-09-25' }).cobra,
    'data que não é data não cobra'
  );

  /* --- 6b. "não é devido" e "não sei calcular" são coisas diferentes --
     `cobra: false` sozinho não distingue as duas, e confundi-las daria
     de graça uma troca sobre dado que ninguém conferiu. Quem chama
     recusa a troca quando `dadoIncoerente` aparece, e segue sem cobrar
     quando ele não aparece. */
  conferir(
    calcularAcertoDeTroca({ ...base, valorPagoDoPeriodo: 100, cicloAtual: 'DECADAL', valorDoPlanoNovo: 200, cicloNovo: 'MONTHLY' }).dadoIncoerente === true,
    'ciclo inventado é dado incoerente'
  );
  conferir(
    calcularAcertoDeTroca({ ...base, valorPagoDoPeriodo: 0, cicloAtual: 'MONTHLY', valorDoPlanoNovo: 200, cicloNovo: 'MONTHLY' }).dadoIncoerente === true,
    'valor pago zero é dado incoerente — não é o mesmo que "nada a cobrar"'
  );
  conferir(
    calcularAcertoDeTroca({ valorPagoDoPeriodo: 100, cicloAtual: 'MONTHLY', valorDoPlanoNovo: 200, cicloNovo: 'MONTHLY', vencimentoAtual: 'amanhã', hoje: '2026-09-25' }).dadoIncoerente === true,
    'data que não é data é dado incoerente'
  );
  conferir(longe.dadoIncoerente === true, 'dias restantes maiores que o ciclo é dado incoerente');

  /* E o controle positivo, que é o que dá sentido aos quatro acima: os
     três "não cobra" LEGÍTIMOS não carregam a marca. Sem este par, um
     `dadoIncoerente` chumbado em tudo passaria pelos testes e a troca
     nunca aconteceria. */
  conferir(barato.dadoIncoerente === undefined, 'rebaixamento não é dado incoerente — é regra');
  conferir(perto.dadoIncoerente === undefined, 'acerto absorvido não é dado incoerente — é regra');
  conferir(hojeVence.dadoIncoerente === undefined, 'vencimento hoje não é dado incoerente — é regra');
  conferir(trimestral.dadoIncoerente === undefined, 'acerto negativo entre ciclos não é dado incoerente — é regra');

  /* --- 7. os sete ciclos estão na tabela -------------------------- */
  const SETE = ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'BIMONTHLY', 'QUARTERLY', 'SEMIANNUALLY', 'YEARLY'];
  conferir(Object.keys(DIAS_DO_CICLO).length === 7, 'sete ciclos, nem mais nem menos');
  conferir(SETE.every((c) => DIAS_DO_CICLO[c] > 0), 'os sete da Asaas estão todos na tabela');
  conferir(DIAS_DO_CICLO.YEARLY === 360, 'ano comercial de 360 dias, coerente com o mês de 30');
  conferir(DIAS_DO_CICLO.MONTHLY === 30, 'mês comercial de 30 dias — decisão do dono');

  /* --- 8. dias entre datas ---------------------------------------- */
  conferir(diasAte('2026-10-10', '2026-09-25') === 15, 'atravessa o mês certo');
  conferir(diasAte('2027-01-01', '2026-12-31') === 1, 'atravessa o ano certo');
  conferir(diasAte('2026-03-01', '2026-02-28') === 1, '2026 não é bissexto: 28/02 → 01/03 é um dia');
  conferir(diasAte('2024-03-01', '2024-02-28') === 2, 'e num ano bissexto são dois');

  /* --- 9. calendário × ciclo comercial (25/09/2026) ----------------
     A troca de um anual pago no mesmo dia foi recusada em produção com
     "dias restantes (365) maiores que o ciclo atual (360)". Primeiro,
     conferir a régua calculada contra os valores conhecidos do calendário:
     se o cálculo dela errar, tudo abaixo erra junto. */
  conferir(DURACAO_CIVIL_MAXIMA.WEEKLY === 7 && DURACAO_CIVIL_MAXIMA.BIWEEKLY === 14, 'semanal e quinzenal: calendário = comercial');
  conferir(DURACAO_CIVIL_MAXIMA.MONTHLY === 31, `mês mais longo: 31, veio ${DURACAO_CIVIL_MAXIMA.MONTHLY}`);
  conferir(DURACAO_CIVIL_MAXIMA.BIMONTHLY === 62, `dois meses mais longos (jul+ago): 62, veio ${DURACAO_CIVIL_MAXIMA.BIMONTHLY}`);
  conferir(DURACAO_CIVIL_MAXIMA.QUARTERLY === 92, `trimestre mais longo: 92, veio ${DURACAO_CIVIL_MAXIMA.QUARTERLY}`);
  conferir(DURACAO_CIVIL_MAXIMA.SEMIANNUALLY === 184, `semestre mais longo (jul–dez): 184, veio ${DURACAO_CIVIL_MAXIMA.SEMIANNUALLY}`);
  conferir(DURACAO_CIVIL_MAXIMA.YEARLY === 366, `ano bissexto: 366, veio ${DURACAO_CIVIL_MAXIMA.YEARLY}`);
  conferir(Object.keys(DURACAO_CIVIL_MAXIMA).length === Object.keys(DIAS_DO_CICLO).length, 'a régua cobre os sete ciclos');
  conferir(
    Object.entries(DURACAO_CIVIL_MAXIMA).every(([c, d]) => d >= DIAS_DO_CICLO[c]),
    'nenhuma régua civil é menor que o ciclo comercial — senão recusaria período comum'
  );

  /* Para cada ciclo mensal: primeiro dia (o período civil inteiro pela
     frente, maior que o comercial), meio, último dia, e um dia além da
     régua. Valor pago 100, plano novo mais barato e mais caro. */
  const ciclosCivis = [
    // [ciclo, pago em, vence em, dias civis do período]
    ['MONTHLY', '2026-10-01', '2026-11-01', 31],
    ['MONTHLY', '2027-01-31', '2027-02-28', 28],
    ['QUARTERLY', '2026-07-01', '2026-10-01', 92],
    ['SEMIANNUALLY', '2026-07-01', '2027-01-01', 184],
    ['YEARLY', '2026-09-25', '2027-09-25', 365],
    ['YEARLY', '2027-09-25', '2028-09-25', 366] // atravessa 29/02/2028
  ];
  /* Aritmética de data civil pura, em UTC de propósito: as datas chegam
     `AAAA-MM-DD` e o relógio do processo não entra (a regra de
     `tests/data-para-asaas-e-de-brasilia.js`). */
  const doisDigitos = (n) => String(n).padStart(2, '0');
  const menosDias = (data, n) => {
    const t = new Date(Date.parse(data) - n * 86400000);
    return `${t.getUTCFullYear()}-${doisDigitos(t.getUTCMonth() + 1)}-${doisDigitos(t.getUTCDate())}`;
  };
  for (const [ciclo, pagoEm, venceEm, diasCivis] of ciclosCivis) {
    const comercial = DIAS_DO_CICLO[ciclo];
    conferir(diasAte(venceEm, pagoEm) === diasCivis, `${ciclo} ${pagoEm}→${venceEm}: ${diasCivis} dias civis`);

    // Primeiro dia: nunca recusa, e o crédito é o que foi pago, nem um centavo a mais.
    const primeiro = calcularAcertoDeTroca({
      valorPagoDoPeriodo: 100, cicloAtual: ciclo, valorDoPlanoNovo: 50, cicloNovo: ciclo,
      vencimentoAtual: venceEm, hoje: pagoEm
    });
    conferir(primeiro.dadoIncoerente === undefined, `${ciclo} no primeiro dia (${diasCivis} civis) não é dado incoerente — era o bug`);
    conferir(primeiro.credito <= 100, `${ciclo} no primeiro dia: o crédito não passa do pago, veio ${primeiro.credito}`);
    conferir(primeiro.diasRestantes === Math.min(diasCivis, comercial), `${ciclo} no primeiro dia: ${Math.min(diasCivis, comercial)} dias comerciais, veio ${primeiro.diasRestantes}`);
    conferir(!primeiro.cobra && primeiro.acerto < 0, `${ciclo} rebaixamento no primeiro dia: não cobra, veio ${primeiro.acerto}`);

    // Último dia: um dia restante, conta idêntica à de antes da correção.
    const ultimoDia = menosDias(venceEm, 1);
    const ultimo = calcularAcertoDeTroca({
      valorPagoDoPeriodo: 100, cicloAtual: ciclo, valorDoPlanoNovo: 200, cicloNovo: ciclo,
      vencimentoAtual: venceEm, hoje: ultimoDia
    });
    conferir(ultimo.diasRestantes === 1, `${ciclo} no último dia: 1 dia restante, veio ${ultimo.diasRestantes}`);
    conferir(ultimo.credito === centavos(100 / comercial), `${ciclo} no último dia: crédito de 1 dia comercial, veio ${ultimo.credito}`);

    // Um dia além da régua civil: continua dado incoerente.
    const alem = menosDias(venceEm, DURACAO_CIVIL_MAXIMA[ciclo] + 1);
    const incoerente = calcularAcertoDeTroca({
      valorPagoDoPeriodo: 100, cicloAtual: ciclo, valorDoPlanoNovo: 200, cicloNovo: ciclo,
      vencimentoAtual: venceEm, hoje: alem
    });
    conferir(incoerente.dadoIncoerente === true, `${ciclo} com ${DURACAO_CIVIL_MAXIMA[ciclo] + 1} dias restantes continua dado incoerente`);
  }

  /* Meio do ciclo: abaixo do ciclo comercial a conta não mudou. 180 dias
     restantes de um anual de 360 pago por 100 = crédito 50. */
  const meio = calcularAcertoDeTroca({
    valorPagoDoPeriodo: 100, cicloAtual: 'YEARLY', valorDoPlanoNovo: 200, cicloNovo: 'YEARLY',
    vencimentoAtual: '2027-03-24', hoje: '2026-09-25'
  });
  conferir(meio.diasRestantes === 180 && meio.credito === 50 && meio.debito === 100 && meio.acerto === 50,
    `anual no meio: 180 dias, crédito 50, débito 100, acerto 50 — veio ${meio.diasRestantes}/${meio.credito}/${meio.debito}/${meio.acerto}`);

  /* O caso real de produção, com os números dele: anual de R$ 10 pago em
     25/09/2026, vencendo em 25/09/2027. Para um anual de R$ 5 é
     rebaixamento sem cobrança; para o semestral de R$ 8 (mais caro por
     dia) o acerto passa a ser calculável, e é cobrado. */
  const real = { valorPagoDoPeriodo: 10, cicloAtual: 'YEARLY', vencimentoAtual: '2027-09-25', hoje: '2026-09-25' };
  const paraAnualDe5 = calcularAcertoDeTroca({ ...real, valorDoPlanoNovo: 5, cicloNovo: 'YEARLY' });
  conferir(paraAnualDe5.dadoIncoerente === undefined && !paraAnualDe5.cobra, 'caso real → anual de R$ 5: troca aceita, sem cobrança');
  conferir(paraAnualDe5.credito === 10 && paraAnualDe5.debito === 5 && paraAnualDe5.acerto === -5,
    `caso real → anual de R$ 5: crédito 10, débito 5, acerto -5 — veio ${paraAnualDe5.credito}/${paraAnualDe5.debito}/${paraAnualDe5.acerto}`);
  const paraSemestral = calcularAcertoDeTroca({ ...real, valorDoPlanoNovo: 8, cicloNovo: 'SEMIANNUALLY' });
  conferir(paraSemestral.dadoIncoerente === undefined && paraSemestral.cobra && paraSemestral.acerto === 6,
    `caso real → semestral de R$ 8: acerto 16 − 10 = 6, cobrado — veio ${paraSemestral.acerto}/${paraSemestral.cobra}`);

  console.log(`proporcionalService: ${checagens} checagens OK`);
}
