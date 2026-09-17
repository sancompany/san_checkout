# San Checkout — SAN & CO. Pay Engine

Estrutura da San & Co. Motor de pagamento whitelabel, modelo pull, Asaas
por baixo. Segue as leis do plugin `san-co`.

> **O plugin é fonte, e a citação dele neste repositório não é.**
> `.claude/settings.json` declara o marketplace, mas plugin só carrega na
> abertura da sessão: `ListPlugins` vazio significa trabalhar de segunda
> mão, e isso já custou uma estação fechada errado em 13/09
> (`docs/erros/2026-09-13-fechei-uma-estacao-contra-a-parafrase-da-lei.md`).
> Sem o plugin carregado, clonar `sancompany/Plugin_san-co` e ler de lá
> antes de fechar qualquer coisa.

## Antes de agir: existe uma skill para isto?

**Procure a skill que corresponde à FUNÇÃO que você está exercendo, e
rode-a.** Não é sugestão e não depende de o dono pedir: pedir uma skill
que existe para a tarefa em curso é trabalho dele fazer duas vezes.

Regra escrita em 17/09/2026 porque o dono tinha pedido `revisar` várias
vezes e ela só rodou naquele dia — e quando rodou, achou dois bugs
graves pré-existentes no caminho do dinheiro em onze ciclos. O custo de
não ter rodado antes é medível: os dois furos ficaram no ar por dias.

A tabela abaixo é **índice, não regra** — pela mesma razão do aviso no
topo deste arquivo: o `description` de cada skill é a fonte, e esta
paráfrase não é. Ela serve para achar a skill certa em um olhar; achada,
lê-se o `SKILL.md` dela. Índice que vira regra é como uma estação foi
fechada errado em 13/09.

| a função que você está exercendo | a skill |
|---|---|
| escrever, refatorar, escolher biblioteca | `construir` |
| revisar mudança antes de commit, merge ou deploy | `revisar` |
| qualquer coisa que toque cobrança, senha, documento, admin, Asaas | `seguranca-san` |
| algo quebrou, teste falhou, comportamento não bate | `depurar` |
| abrir/fechar estação, estrutura, prontidão, subir para produção | `leis` |
| dado novo, integração de terceiro, texto legal, ir ao ar | `legal` |
| onde uma capacidade mora, banco compartilhado ou separado | `classificar` |
| integrar um projeto ao San Checkout | `checkout` |
| ideia nova, escopo de projeto novo | `novo-projeto` |

São **nove** skills no plugin em 17/09/2026, e as nove estão na tabela —
se um dia a contagem não bater, a tabela envelheceu e o plugin manda.

Duas ou mais se aplicando ao mesmo trabalho, rodam todas — `revisar`
manda explicitamente chamar `seguranca-san` quando a mudança toca
dinheiro ou dado de cliente.

E o aviso do topo vale aqui com força: **`ListPlugins` vazio significa
trabalhar de segunda mão.** Sem o plugin carregado, clonar
`sancompany/Plugin_san-co` e ler o `SKILL.md` da fonte — foi assim que a
`revisar` foi lida em 17/09.

## Antes de propor ou escrever qualquer coisa, leia
- `CONSTRAINTS.md` — o que NÃO se faz aqui, os limites e as exceções
- `docs/funcional.md` — o que o sistema faz, tela por tela. Comportamento alterado se reescreve ali, na mesma tarefa
- `docs/specs/2026-09-11-san-checkout.md` — por que existe, e os contrapontos
- `docs/erros/` — o que já deu errado aqui; não repita
- `docs/pendencias.md` — o trabalho que falta, e o que só o dono faz
- `RUNBOOK.md` — como operar, reverter, restaurar e responder a incidente
- `API.md` — o contrato que os contratantes consomem
- `README.md` — como rodar e testar

## Classificação
Porte: multi-inquilino · Dado: de terceiro, com dinheiro · Vida útil: longa
→ **topo da escala de rigor** (Lei 0: nada aqui se dispensa por proporcionalidade)

## Estado na esteira
Estação atual: **6 Prontidão, aberta em 14/09/2026** — autorizada pelo
dono, com as três condições de `varredura-final.md` conferidas no dia
(commit servido = main, migrations aplicadas, árvore limpa). Pede Opus
com esforço alto, e é da sessão por inteiro.

> Em 13/09 eu emendei direto no passo 1 da Estação 6 sem pedir. O
> trabalho achou dois furos reais e mesmo assim estava fora de ordem —
> `docs/erros/2026-09-13-avancei-para-a-estacao-6-sem-autorizacao.md`.
> Abrir estação é decisão, não consequência de o caminho estar livre.

| # | estado | evidência, e onde se confere |
|---|---|---|
| 1 Escopo | **fechada** 13/09 | métrica de sucesso escrita no spec, seção "Métrica de sucesso": cobrança confirmada, contada por contratante |
| 2 Fronteiras | **fechada**, reaberta e refechada 12/09 | seção "Classificação de fronteira" do spec: Access registrado ali, e hospedagem escolhida por número medido (23 ms × 220 ms) |
| 3 Fundação | **fechada** 13/09 | `Segurança` **run #5 verde** em `5f3adf3` (os três jobs), depois de #1 a #4 vermelhas; SHAs reconferidos por `git ls-remote`; `RUNBOOK.md` existe |
| 4 Contratos | **fechada** 13/09, refeita no fim do dia | `API.md` e migrations OK; `docs/funcional.md` reescrito contra `definicao-funcional.md` **lido na fonte** — seis das dez seções divergiam da paráfrase que eu vinha usando (`docs/erros/2026-09-13-fechei-uma-estacao-contra-a-parafrase-da-lei.md`). As quatro perguntas de prontidão respondem "sim" no fim do arquivo |
| 5 Construção | no ar, com **exceção registrada** | `b753716` no ar e **conferido em produção** em 13/09 (`taxa: null` no pedido sem valor; caminho inventado devolve 404). Pagamento em **sandbox** por decisão do dono, registrada em `CONSTRAINTS.md` §3 ("Estação 5 · deploy em produção apontando para o sandbox") com o plano de duas rodadas e o custo escrito |
| 6 Prontidão | **aberta** 14/09 | autorizada pelo dono, com escopo ampliado (`CONSTRAINTS.md` §4). Estado em 17/09: main = `b57df2b` (PR #17 mesclado) e **é o commit ativo no Northflank**, `/api/saude` 200, migrations 0001-0009 aplicadas, árvore limpa |

**Escopo da 6, tudo no sandbox** (`CONSTRAINTS.md` §4). Feito em 14/09:
- **Segurança de fora:** limpo (Supabase RLS default-deny, admin
  fail-closed, IDOR 401/403 ao vivo, erro genérico, webhook fail-closed).
  Dois furos corrigidos e no ar: `alvoDeRede` (https+host público em
  apiBaseUrl/webhookUrl) e `search_path` (migration 0004). A hipótese da
  origem-bypass caiu — a API é DNS-only, pública por desenho
  (`docs/erros/2026-09-14-origem-direta-alcancavel-por-fora.md`).
- **Ponta a ponta Pix:** completo (pago→webhook→status→conciliação→estorno,
  negativos 401/403). Assinatura: criação + ciclo auth/404; **falta a
  metade paga** (cartão no pop-up).
- **Prontidão:** scrypt medido (~1–1,3 s, manter N=2^17); métrica
  respondível; e-mail confirmado; alerta de queda com metade de código
  feita (`/api/saude` 503 na queda).

Feito em 15/09:
- **`returnUrl` honrado, e fechado no nascimento** (`retornoSeguro.js`,
  migration 0005, `API.md` §3.1, RN-15/16). O checkout ignorava o
  parâmetro: quem pagava ficava parado na tela de sucesso sem caminho de
  volta. Honrá-lo sem allowlist teria aberto *open redirect* — por isso
  o destino só vale se a **origem** dele pertencer ao contratante, a
  comparação é por `URL.origin` (nunca por texto) e quem decide é o
  servidor, que nunca manda a lista para o navegador.
  Atacado ao vivo por HTTP: 22 cargas, **com dois controles positivos**
  — a primeira rodada deu "recusou" em tudo, inclusive no que devia
  passar, porque a chave estava falsa e toda resposta era 502. Sem os
  controles, teria passado por prova.
  A suíte de regressão (`tests/retorno-nao-vira-open-redirect.js`) foi
  verificada por **sabotagem deliberada**: pega tanto o front decidindo
  sozinho quanto o controller ecoando o parâmetro cru.
- **Vínculo da assinatura corrigido** — o furo mais caro achado até
  agora, e quem achou foi o MostrAí, com dinheiro real no sandbox. O
  `CHECKOUT_PAID` não traz o id do pagamento: a cobrança ficava
  `confirmado` com `charge_id` nulo, e com ela morriam o cancelamento e
  **todo ciclo seguinte da assinatura**, em silêncio. Agora quem vincula
  é o `PAYMENT_CONFIRMED`, por `payment.checkoutSession`, com guarda que
  impede o ciclo 2 de sobrescrever a primeira cobrança —
  `docs/erros/2026-09-15-confiei-que-o-checkout-paid-traria-o-id-do-pagamento.md`.
  `API.md` §4.3.6 também estava errado: dizia que a idempotência é
  sempre por `chargeId`, sem ressalvar que o payload de assinatura não
  tem esse campo. O integrador leu certo; o texto é que estava
  incompleto. Revisão em 5 ciclos (`revisar` + `seguranca-san`); o furo
  gêmeo do `assinatura_pix` foi **declarado, não corrigido às cegas** —
  por decisão do dono, virou atualização futura
  (`docs/proximas-versoes.md`).
- **Varredura depois da correção, e ela achou mais dois** — os dois da
  mesma família ("efeito real dependendo de coisa não verificada"), os
  dois no caminho do dinheiro:
  - **o aviso ao contratante segurava a resposta à Asaas.** O receptor
    aguardava o processamento antes do `200`, e a cadeia terminava num
    `fetch` **sem timeout** para o endpoint de um terceiro. Um
    contratante pendurado pausaria a fila da conta inteira (15 falhas,
    §2.3) — derrubando a confirmação de pagamento de TODOS os outros.
    Medido ao vivo contra um servidor mudo: preso indefinidamente →
    10 s com teto → ~0 sem aguardar.
  - **`chamarAsaas` também não tinha teto**, e por ela passa toda
    cobrança, consulta, estorno e cancelamento.
  Cobertos por `tests/nenhuma-chamada-de-saida-sem-teto.js`, que varre o
  `src/` inteiro em vez de confiar em memória — a regra já era conhecida
  (`pedidoService` fazia certo) e mesmo assim não foi aplicada nos
  outros dois. `CONSTRAINTS.md` §2.7.1.
- **Ciclo de assinatura vinha errado, e a 1ª correção repetiu o mesmo
  bug.** Verificando o reparo do mostrai ao vivo: a assinatura ficou
  `MONTHLY` quando o plano é `QUARTERLY` — `amarrarAssinaturaACobranca`
  lia `payment.cycle`, que não existe em payload nenhum. Primeira
  tentativa: um relay via webhook (capturar no `CHECKOUT_PAID`, ler no
  `PAYMENT_CONFIRMED`) — funcionava, mas era o mesmo erro com um passo a
  menos (dependia de webhook pra um dado que não é dado de webhook), e
  tinha residual de ordem. Corrigido de verdade gravando `ciclo` na
  **criação** do checkout (`criarCheckoutAssinatura` já valida e conhece
  o valor antes de existir qualquer sessão na Asaas) — elimina o relay
  inteiro e o residual de ordem junto, migration 0006 mais enxuta.
  Revisão em 3 ciclos; `proximaCobranca` continua `null`, declarado
  (`docs/pendencias.md`) — sem fonte confiável hoje.
  `docs/erros/2026-09-15-ciclo-de-assinatura-nao-vinha-de-webhook-nenhum.md`.
- **Auditoria do caminho da assinatura inteiro**, exercitado ao vivo
  contra o sandbox (criação, conciliação, cancelar/pausar/retomar, auth
  e validação nas 4 rotas, polling do pop-up). Achou **mais um furo
  real, provado ao vivo**: `/cancelar-assinatura` buscava só `ativa`,
  então uma assinatura **pausada não podia mais ser cancelada** — a
  MESMA linha respondia 200 no `/pausar-assinatura` e 404 no
  `/cancelar-assinatura`. Pausar era porta de mão única: a assinatura
  ficava INACTIVE na Asaas sem saída pela API. Corrigido, com
  `tests/assinatura-pausada-continua-cancelavel.js` travando a regra
  ("tudo que pausar alcança, cancelar alcança") em vez do literal.
  Também: o ciclo 2+ nascia sem `ciclo`, perdendo o dado na
  cobrança-modelo a partir do 3º — agora copiado.
  Declarado, não corrigido: o grupo de eventos de assinatura da Asaas
  não é tratado nem documentado no §2.2, então assinatura encerrada
  fora do nosso fluxo nunca chega até nós (`docs/pendencias.md`).
- **Renovação abandonada mentia "cancelada" pro contratante.** Fechar o
  pop-up de troca de cartão (`&renovar=1`) sem pagar deixa a assinatura
  ANTIGA intocada e ativa — mas o código mandava `evento: 'cancelada'`
  do mesmo jeito, e o payload só identifica por `planoId`+`documento`
  (API.md §4.3.4): o contratante não tinha como diferenciar isso de um
  cancelamento de verdade, e um contratante que confia nisso revogaria
  acesso de quem ainda está pagando. Corrigido: renovação abandonada
  não notifica nada (a antiga segue como está); assinatura NOVA
  abandonada continua mandando `cancelada`, como já era documentado.
  RN-20 (`docs/funcional.md`).

Feito em 16/09:
- **Primeira assinatura de verdade paga no pop-up** (`sub_qut6521d50496vkn`,
  testemaster/plano_anual, R$10) — o ciclo completo criar → pausar
  → (idempotência) → retomar → conciliar → cancelar → (cancelar de novo
  = 404, não `jaEstava`) exercitado ao vivo, sem fixture. Confirmou o
  bug já conhecido do `ciclo` (grava `MONTHLY` em vez de `YEARLY`,
  porque produção ainda não tinha o PR do dia anterior) e revelou um
  furo novo: **`/cancelar-assinatura` nunca notificava o contratante**
  — só a resposta síncrona, quebrando a seta que o `API.md` §7.4 já
  desenhava. RN-21.
- **Varredura de achados graves, em duas rodadas**, com foco em
  assinatura e o resto como secundário (agentes em paralelo, cada
  achado verificado por mim antes de entrar na lista — sem inflar
  número). Primeira rodada, 6 achados:
  - conciliação confundia tentativa de renovação abandonada com o
    ciclo real (RN-22);
  - assinatura por Pix Automático perdia `ciclo`, reintroduzindo o bug
    do dia anterior por outra porta (não tem dano ativo — Pix
    Automático está desligado nesta conta, `CONSTRAINTS.md` §2.4);
  - `API.md` §4.3.6 prometia uma deduplicação entre CICLOS que nunca
    existiu (a chave só deduplica *retry*, não ciclo — texto
    corrigido);
  - rate limit de criação (10/min) também travava o polling de status
    de Pix/Boleto — o próprio polling (3s) esgotava a janela em ~30s;
    limitador migrado de montagem por prefixo pra montagem por rota
    (`src/middlewares/limitadores.js`, novo);
  - pop-up bloqueada travava o botão de pagamento pra sempre, sem erro,
    em cartão avulso E assinatura por cartão (RN-24);
  - o achado do `/cancelar-assinatura` acima, já corrigido antes da
    varredura.
  Segunda rodada (revisão de regressão dos 6 + ângulos de banco/
  concorrência ainda não cobertos), 2 achados confirmados e 1 declarado:
  - **regressão no meu próprio fix da rodada 1**: o filtro da
    conciliação exigia `status = 'confirmado'` exato, escondendo uma
    renovação que confirmou e **depois foi estornada** — corrigido pra
    excluir só os status que significam "nunca aconteceu"
    (`pendente`/`cancelado`/`expirado`), não por uma lista positiva
    (RN-22, revisado);
  - **condição de corrida real**: a Asaas reenvia webhook (§4.3.6, "pode
    chegar mais de uma vez"), e duas entregas quase simultâneas do
    MESMO `PAYMENT_CONFIRMED` de um ciclo novo notificavam
    `cobranca_confirmada` DUAS VEZES pro contratante — sem nenhum campo
    no payload pra ele perceber (RN-18: assinatura não tem `chargeId`).
    Corrigido detectando a violação do `unique` de `charge_id`
    (código Postgres `23505`) e sinalizando a entrega perdedora pra não
    notificar (RN-23);
  - **declarado, não corrigido às cegas**: sem reconciliação quando
    cancelar/pausar/retomar perde a confirmação da Asaas por timeout —
    a correção óbvia exige confirmar o formato real de
    `GET /v3/subscriptions/{id}` pra uma assinatura deletada antes de
    codificar, e isso não está medido. `docs/pendencias.md`.
  Todos os fixes testados com sabotagem (inclusive uma correção no
  próprio teste do achado da corrida, cuja primeira versão passava
  mesmo sabotada — corrigida antes de confiar nela) e `npm run check`
  verde em cada commit.
- **Terceira rodada de varredura**, com o mesmo escopo grave-só, achou
  mais dois: `criarLimitadorConsulta` já tinha virado fábrica antes
  desta sessão, mas `limitadorCriacao` continuou sendo uma única
  instância de `rateLimit()` compartilhada entre 7+2 rotas (cartão,
  assinatura, assinatura-pix, estornar, cancelar/pausar/retomar-
  assinatura, e as duas criações de pix/boleto) — corrigido, virou
  fábrica também. E o mais grave da sessão: **`renovar=1` bastava
  sozinho pra achar e depois cancelar a assinatura de OUTRA pessoa** —
  `documento` não é segredo, e a rota de criação é pública. RN-25.
- **Mapa completo do ciclo de assinatura**, pedido pelo dono depois da
  3ª rodada: 11 etapas + a variante Pix Automático, todo erro já achado
  catalogado contra a etapa onde vive (`docs/ciclo-assinatura-mapa.md`).
  Achou mais duas coisas pequenas relendo o código do zero (um
  comentário órfão colado na função errada; 3 citações desatualizadas
  de `INTEGRACAO.md`), e descartou uma suspeita de bug depois de
  verificar com cuidado (CHECKOUT_PAID duplicado não repete `criada`
  de um jeito que faça dano — esse evento só existe uma vez na vida da
  assinatura, a dedup documentada já filtra).
- **RN-25 corrigido**: `renovar` agora precisa ser um token HMAC-SHA256
  que só quem tem a `api_key` do contratante consegue gerar
  (`src/utils/tokenRenovacao.js`, receita em Node/PHP/Python no
  `API.md §7.3`). Sem token válido (inclusive o formato antigo,
  `&renovar=1`), degrada pra assinatura nova comum — nunca amarra nem
  cancela nada; é o modo seguro, não um erro que trava o pagador.
  **Mudança incompatível**: qualquer integração real usando
  `&renovar=1` hoje precisa trocar pra gerar o token. Testado com
  sabotagem nos dois níveis (o algoritmo em si, e a fiação no
  controller que usa ele em vez de confiar em `renovar` sozinho).
- **Três declarações fechadas por MEDIÇÃO, não por leitura de doc.** Eu
  vinha dizendo "não dá pra medir" segurando as ferramentas — o dono
  chamou isso ("o que não falta é você ficar cego"), e estava certo. O
  `GET` rodou **dentro do container de produção** (a `ASAAS_API_KEY`
  nunca sai de lá; só o corpo da resposta volta):
  - **assinatura cancelada responde `200` com `deleted: true` e
    `status: "INACTIVE"`** — o MESMO status de uma pausada. Olhar o
    status antes do `deleted` marcaria toda cancelada como `pausada`;
    a ordem é a correção inteira. O `404` sobrou só pra id de outra
    conta, o que confirma ele NÃO virar "cancelada".
  - **a resposta traz `cycle`, e ele reparou dado errado de verdade**:
    `sub_j87cq5u50g6jqv6t` (MostrAí, **ativa**, R$267,30) estava
    `QUARTERLY` na Asaas e `MONTHLY` aqui. A conciliação agora corrige
    (RN-26.1) — a correção de 15/09 só valia pras assinaturas novas, e
    sem isto as antigas ficariam erradas pra sempre. As três linhas do
    banco foram reparadas com o valor medido.
  - **zero eventos `SUBSCRIPTION_*` entre os 53 configurados.** Não era
    ambiguidade de documentação: a Asaas nunca nos avisa de nada de
    assinatura. `CONSTRAINTS.md` §2.2 ganhou a seção que faltava — o
    grupo estava desmarcado sem nenhuma decisão registrada, que é
    exatamente a falha que a declaração de "referência única" existe
    pra impedir.
  A medição também achou um furo novo: a Asaas **continua devolvendo
  `nextDueDate` de uma assinatura deletada**, e repassar isso diria ao
  contratante que existe cobrança marcada pra uma assinatura que nunca
  mais vai cobrar. Corrigido. Tudo travado pelo autoteste novo de
  `cobrancaConsultaController.js` (15 checagens), verificado por
  sabotagem nas quatro regras.
- **PR #16 mesclado e conferido ao vivo em produção.** `d793f2e` é o
  commit ativo no Northflank, e a conciliação foi chamada de verdade
  contra `sub_qut6521d50496vkn`: devolveu `status: cancelada`,
  `ciclo: YEARLY`, `proximaCobranca: null`. Sem as correções viria
  `pausada`, `MONTHLY` e `2027-09-16` — as três regras novas provadas de
  uma vez, no ar, não em teste.
- **Troca de plano: decidida como atualização futura, não pendência.** O
  dono perguntou se o checkout atendia as duas aplicações do MostrAí.
  **Cancelar plano já está pronto** (§7.4, exercitado ao vivo). **Trocar
  plano não existe** — e o motivo que eu dei aqui estava **errado**: eu
  escrevi que `valor` e `ciclo` são congelados pela Asaas, "não por
  escolha nossa". ⚠️ **Corrigido em 17/09/2026 por medição** — a Asaas
  aceita `PUT /v3/subscriptions/{id}` mudando `value` e `cycle`, e com
  `updatePendingPayments: true` muda até a cobrança pendente já gerada.
  O congelamento é **do nosso fluxo**. Decisão do dono na conversa de
  16/09: o MostrAí segue pela **ideia do pedido avulso** — decisão que
  volta a ser dele, porque foi tomada sobre a premissa falsa. Tudo em
  `docs/proximas-versoes.md`, com a tabela da medição e o **controle
  negativo** que dá sentido a ela: a Asaas responde `200` e ignora em
  silêncio campo que não conhece, então status não prova nada — quem
  prova é o `GET` de volta.

Feito em 17/09, tudo no ar (`b57df2b`):
- **Restauração ensaiada** (`npm run ensaio-restauracao`): Postgres da
  mesma major da produção, migrations, dados, e comparação em cinco
  níveis com o banco no ar. Zero divergência, **RTO 1 s**. É o primeiro
  lugar que PROVA que as migrations descrevem o banco real — e já
  acusou as 0007 e 0008 antes de aplicadas. Fecha metade da exceção da
  Lei 6; falta a cópia periódica fora do provedor.
- **Captura de exceção** (Lei 8), sem serviço externo: tabela `erros`
  (0007), aba no painel. Agrega por impressão digital, senão rota
  pública que dá 500 vira escrita ilimitada no banco.
- **Métrica por dia civil de Brasília**: exigiu `confirmado_em` (0008),
  que não existia — "confirmadas ontem" era inrespondível por falta de
  dado, não de recorte. O processo roda em **UTC**, medido no contêiner.
- **Acessibilidade WCAG 2.2 AA** (`npm run acessibilidade`): cinco
  violações reais corrigidas; a causa raiz era paleta duplicada nas
  páginas legais.
- **Troca para produção preparada**: `API.md` §11.1 (nada de sandbox
  atravessa), `RUNBOOK` §6.2, e `npm run limpar-teste`. A URL do webhook
  é `/api/webhooks/asaas` **plural** — o singular dá 404, conferido.
- **Pessoa física, em transição**: documentos legais reidentificados, v1
  arquivada. Subconta é bloqueio da Asaas (conta PF no registro), virou
  atualização futura — sem split, 100% na conta-mãe, exceção §3.

> Três coisas quase passaram por prova nesta rodada, e a lição é a
> mesma: **evidência sem controle não é evidência.** Um RPO falso no
> RUNBOOK (media tráfego, não backup); um verificador de acessibilidade
> reportando "0 violações" sobre a tela de *"Acesso não autorizado"*; e
> um teste que só pegou a sabotagem depois de eu corrigir o próprio
> teste. Todas caíram por controle positivo.

Ainda em 17/09, a segunda metade do dia — o dono pediu para eu fechar
tudo que era meu, e estas eram as pendências que restavam do meu lado:
- **Recusar cedo o que a Asaas recusa** (RN-28, RN-29). O piso de
  R$ 5,00 no valor cobrado, medido nos seis caminhos de criação com
  controle positivo em R$ 5,00 exato; e a regra do telefone, que **não
  era a que estava escrita na pendência** — "dígito repetido" é falso,
  `11988888888` passa. 24 combinações medidas para achar a regra real
  antes de escrever validador: errar aqui recusa comprador legítimo no
  caminho do dinheiro, que é pior que o bug original.
- **SSRF residual do pull fechado** (RN-30): redirect revalidado a cada
  salto, só mesma origem, e corpo com teto de 1 MiB contado no fluxo. A
  regra de mesma origem não é só anti-SSRF — a requisição leva a
  `X-Checkout-Key` do contratante, que autoriza estorno.
- **O Express passou a subir no teste** (Lei 0). O roteiro de login por
  token, exercitado à mão em 12/09, virou suíte contra a pilha montada
  de verdade. Uma sabotagem dela passou e revelou um **comentário falso**
  no `server.js` sobre ordem de limitadores — medido e corrigido.
- **A rotina de expurgo de dado pessoal existe** (Lei 10, RN-31), por
  lista branca do que fica, conferida em simulação contra o banco de
  produção com controle positivo.
- **Três decisões do dono registradas**: o canal de alerta é o e-mail de
  falha da Asaas (com a ressalva de que tráfego zero não dispara nada);
  alerta de orçamento e cópia periódica fora do provedor viraram
  atualizações futuras — a Asaas é a cópia, e o que ela NÃO cobre está
  escrito em `CONSTRAINTS.md` §3.
- **Documentos falsos corrigidos**: esta seção dizia "Estação 6 não
  iniciada"; o mapa dizia 18 suítes; `docs/pendencias.md` pedia um ciclo
  de segurança que rodou em 14/09, e declarava uma regra de validação de
  telefone que a medição desmentiu.
- **A skill `revisar` rodou pela primeira vez sobre este código** — era
  pendência da Lei 0, e a entrada dela no `pendencias.md` era um título
  sem corpo. Onze ciclos, parando no primeiro limpo. Achou dívida em dez
  das onze voltas, e **dois bugs graves pré-existentes no caminho do
  dinheiro**: o `documento` gravado cru fazia `552.085.198-01` e
  `55208519801` virarem duas chaves para a mesma pessoa, deixando
  assinatura incancelável pela API (RN-32); e o piso da Asaas é **por
  parcela**, que a minha primeira medição não viu porque mediu só com
  uma — R$ 24,00 em 12x é recusado, e a sessão da pop-up é aceita, então
  a recusa só apareceria lá dentro com o cartão já digitado. A correção
  oferta menos parcelas em vez de recusar a venda, e a tela corta a
  lista com o número que o servidor manda.
- **`seguranca-san` junto**, e ela fechou a lição nº 23: a lista de
  rotas limitadas passou a ser conferida por teste contra a lista de
  rotas montadas (33 rotas, 17 prefixos), em vez de a olho.
- **Oito autotestes tinham contador de checagens chumbado**, três deles
  mentindo — `validadores` dizia 40 e tinha 91, e `senhaAdmin` dizia 22
  e tinha 20, superestimando. Todos passaram a contar.
- **Os três estados novos do checkout foram auditados em navegador de
  verdade** (`npm run acessibilidade`), com checagem de que o estado
  ACONTECEU antes de auditar — e o dublê do pedido estava com o formato
  de item errado desde que foi escrito, então a linha de item nunca
  havia sido exercitada.
- **O RUNBOOK foi TESTADO, e o teste achou oito furos** — inclusive dois
  que eu havia escrito horas antes. O dono mandou resolver as pendências
  sem ele; como não existe pessoa número dois, o teste do item 6 rodou
  com um **agente sem nenhum contexto**, podendo ler só o `RUNBOOK.md` e
  proibido de escrever. Ele respondeu "está no ar" e achou o vencimento
  do domínio sozinho; **não conseguiu publicar**, porque não havia
  caminho escrito de uma branch até a `main`, nem forma de saber **qual
  commit está no ar** (e a §4 pedia `git revert <sha-ruim>`). Os quatro
  com consequência real: as migrations `0001…0006` quando existem nove;
  o comando "seguro" que listava 10 de 11 variáveis e comia a
  `ASAAS_AMBIENTE`; a conferência do webhook sem o método (com `GET` o
  certo e o errado dão 404 igual — só `POST` distingue); e a reversão
  sem o sha. Tudo corrigido e conferido, tabela em `RUNBOOK` §10, e a
  regra nova: **depois de editar o RUNBOOK, rodar um leitor sem
  contexto.** A lição que fica é mais dura que os furos: **comando
  escrito e não rodado é comando falso** — dois dos oito eram meus, de
  poucas horas antes.
- **A política de privacidade nomeava o Render, que não é mais usado**
  (`docs/erros/2026-09-17-a-politica-de-privacidade-nomeava-um-fornecedor-que-nao-existia-mais.md`).
  Fui escrever o aviso do Web Analytics e achei coisa pior ao lado: o
  documento que declara **para onde os dados do titular vão** apontava o
  fornecedor errado, e afirmava transferência internacional onde ela
  não acontece mais (a Northflank roda em região brasileira, medido). E
  prometia comunicação transacional ao Pagador que o sistema **não
  faz** — não há biblioteca de e-mail no `src/`, e as notificações da
  Asaas ao comprador nascem desligadas. Política na **v3**, v2
  arquivada, inventário de dados corrigido, e a Cloudflare finalmente
  declarada como fornecedora (Pages, DNS, Access e Web Analytics, este
  com `auto_install` confirmado pela API). Migração de hospedagem é
  troca de subprocessador: termina no inventário e na política, não no
  deploy verde.
- **Desempenho medido, e a medição achou defeito** (item 4:
  `npm run desempenho`). Chromium de verdade num funil de celular (CPU
  4x mais lenta, 1600 kbps, 150 ms), cinco telas do comprador, orçamento
  que falha com código 1. A tela de **assinatura tinha CLS de 0,409**,
  quatro vezes o teto: o fieldset de endereço era revelado depois da ida
  à rede e empurrava o bloco de pagamento, o aceite e o botão para
  baixo — deslocamento na parte da tela onde o dedo já está indo. Como
  ele não depende da resposta, passou a aparecer antes do `await`:
  **0,409 → 0,033**, reconferido, e provado por sabotagem (desfazer a
  correção reprova a tela). O número é de laboratório e o "p75" é sobre
  as rodadas, não sobre usuários — está escrito no script, porque
  chamar isso de p75 de campo seria mentira. E uma frase minha do mesmo
  dia estava errada: eu escrevi que "o projeto não tem analytics de
  terceiro". Tem — o **Web Analytics da Cloudflare**, injetado pela
  própria Cloudflare (por isso não aparece no HTML), sem cookie e sem
  perfil, e é ele que vai ter o p75 de **campo** quando houver
  visitante. Consequência achada junto: a política de privacidade não o
  menciona, e pela orientação da ANPD analytics sem cookie dispensa
  banner mas **não** dispensa o aviso — virou pendência da Estação 7,
  porque documento legal não se reescreve por conta própria.
- **O logo pesava 127 KB para aparecer com 32 px de altura** (item 5,
  "imagens otimizadas"): PNG de 1378x1378 na primeira tela do comprador,
  em dado móvel. Virou um de 192 px e **8,9 KB**, com o grande mantido
  só no `og:image`. Travado por orçamento de 30 KB por imagem no
  `npm run desempenho` — porque a forma de isso voltar não é um bug
  novo, é alguém apontando o `src` de volta.
- **`Cache-Control: no-store` em toda resposta de `/api`** (item 5). Não
  existia nenhum: quem decidia guardar era o navegador e qualquer
  intermediário, pelo palpite dele — botão "voltar" repintando pedido
  pago como pendente, e proxy compartilhado podendo servir o pedido de
  um comprador para outro. Coberto por teste na pilha montada, **com
  controle positivo de que fora de `/api` o header NÃO é aplicado** —
  senão a correção mataria o cache do front sem ninguém ver.
- **As sete seções que faltavam no `RUNBOOK`** (item 6 da prontidão:
  "outra pessoa consegue operar"). Inventário de contas, segredos e como
  rotacionar cada um, alerta → significado → primeira ação, incidente
  com dado pessoal **com os prazos da ANPD lidos na fonte da skill
  `legal`** (nunca de cabeça: prazo legal chutado é prazo perdido),
  dependências externas e o que cada queda derruba, contatos, e como
  desligar tudo sem deixar assinatura cobrando. Medido no dia, não
  suposto: o domínio vence **31/08/2027** (RDAP), o CI **não usa segredo
  de repositório** nenhum, e a zona **não tem SPF** com `p=reject` no
  DMARC — achado novo, e a correção é DNS, que é do dono. O que só o
  dono tem ficou marcado `⬜` no arquivo em vez de inventado.
- **A métrica de sucesso parou de contar uso interno** (RN-33, migration
  0009). As colunas `ambiente` e `e_teste` em `cobrancas` estavam
  desenhadas na 0004 e nunca foram escritas — sem elas, o pagamento de
  teste do dono entraria na conta como resultado de negócio no primeiro
  dia de dinheiro real, e é este o número que mede o projeto. `ambiente`
  vem da configuração do processo, nunca do corpo da requisição;
  `e_teste` é de **mão única**, travada por gatilho no banco em vez de
  por código de aplicação. As duas regras foram provadas ao vivo contra
  produção com uma cobrança descartável, apagada depois, e a métrica nova
  rodou **dentro do contêiner** (nenhum dado pessoal desceu para disco):
  10 lidas, 0 de negócio, 10 excluídas, soma conferindo. O painel mostra
  o excluído num cartão próprio e tem dois vazios diferentes — "não
  houve cobrança" e "houve, e nenhuma era de negócio" —, porque com dez
  cobranças de sandbox no banco a frase antiga seria falsa.
  **O ciclo de revisão da própria mudança achou um furo nela:** o
  `select` da rota não trazia as duas colunas novas, e coluna ausente
  chega `undefined` — o filtro excluiria TODA cobrança, para sempre,
  dando hoje o número certo por coincidência. Corrigido, e travado por
  uma checagem geral: todo campo que o agregador lê de uma linha tem de
  estar no `select` da rota
  (`docs/erros/2026-09-17-o-filtro-dependia-de-coluna-que-a-consulta-nao-trazia.md`).

Falta para fechar a 6, e **nada disso é código nosso**: o ciclo de
assinatura pago em produção e a marcação dos eventos `SUBSCRIPTION_*`
(exigem payload real); o primeiro pagamento real de valor baixo, que é o
gatilho escrito da exceção de backup (§3). Tudo isso vem depois da troca
da Asaas para produção, que é do dono e que fecha a 5 sem ressalva. O
MostrAí retesta o lado dele em paralelo.

Do item 6 sobraram três, e **duas mudaram de natureza em 17/09** depois
de o dono mandar resolver sem ele:

- **O registro SPF deixou de ser decisão e virou permissão.** O valor
  está definido e conferido na fonte do Google
  (`v=spf1 include:_spf.google.com ~all`), a credencial da Cloudflare
  está no ambiente, e o comando está pronto no `docs/pendencias.md` —
  mas **o classificador de permissões do harness recusa escrita de
  DNS**, e não há caminho alternativo (não há MCP da Cloudflare aqui,
  `wrangler` não está instalado, e rotear a mesma escrita por subagente
  seria contornar a guarda, não usá-la). Falta liberar a permissão ou
  colar o registro no painel: um segundo de trabalho.
- **O teste da pessoa número dois foi rodado por um substituto** — um
  agente sem contexto, lendo só o RUNBOOK (§10 dele tem o resultado).
  Ele achou oito furos, quatro com consequência real. O que **não** dá
  para substituir é a metade com credencial: publicar de verdade e
  entrar no `/admin`. Isso só fecha com pessoa.
- **Os campos `⬜`** do inventário de contas e dos contatos encolheram:
  o que API responde eu preenchi (conta e 2FA da Cloudflare, planos,
  regiões, ids, vencimento do domínio, quatro projetos de Pages). O que
  sobra é o que **nenhuma API responde** — onde a senha mora, qual
  cartão paga, e o contato direto do dono.

## Mapa de caminhos
- Entrada: `src/server.js` · rotas `src/routes/` · controladores `src/controllers/` · regras e integrações `src/services/`
- Dados: `supabase/migrations/` · variáveis `.env.example`
- Telas: `public/` · tokens visuais `public/css/theme-engine.css` · componentes `public/css/components/`
- Integração Asaas: `src/config/asaas.js` (único que sabe URL e ambiente) e `src/services/asaasService.js`
- Endereço que vem de fora: `src/utils/alvoDeRede.js` (alvo de saída, anti-SSRF) e `src/utils/retornoSeguro.js` (o `returnUrl`, anti open redirect) — os dois decidem no servidor, nunca no front
- Documentos legais: `public/termos.html` e `public/privacidade.html` (vigentes) · versões antigas em `docs/legal-arquivado/`
- Medição que precisa de navegador (fora do `npm test`, porque o CI não tem Chromium): `npm run acessibilidade` (axe-core, WCAG 2.2 AA) e `npm run desempenho` (`scripts/desempenho.mjs` — LCP/INP/CLS num funil de celular, mais o orçamento de 30 KB por imagem)
- Testes: `tests/` — `npm test` roda as 32 suítes; `npm run check` roda a análise de sintaxe de todo JS (inclusive `public/js/`, que os testes não alcançam) e depois as suítes. **Este número é conferido por teste** (`tests/o-que-os-documentos-afirmam.js`): ele já esteve errado três vezes em 17/09/2026, e corrigir à mão não impedia a próxima
- Imagem de produção: `Dockerfile` · CI: `.github/workflows/`

## Conformidade
Violação segue o ciclo da skill `leis`. Não existe estado final fora de
conformidade: ou corrige, ou vira exceção registrada no `CONSTRAINTS.md`.

## Pendências que bloqueiam a esteira

> Esta seção dizia **"Estação 6 · não iniciada, esperando autorização"** e
> **"antes de abrir a 6"** até 17/09/2026 — três dias depois de a estação
> ter sido aberta e quase toda executada, com o estado verdadeiro escrito
> logo acima, no "Estado na esteira". Duas partes do mesmo arquivo se
> contradizendo é a falha que este documento existe para não ter: quem
> lesse só esta seção planejaria de novo um trabalho já feito.

**O que falta para fechar a Estação 6** — nada disso é código nosso:

- **A troca da Asaas para produção** (as três variáveis no Northflank e o
  webhook de produção em `/api/webhooks/asaas`, plural). É do dono, e ele
  a fez depender de o MostrAí bater o mesmo ponto de equilíbrio deste
  lado. Fecha junto a ressalva da Estação 5 (`CONSTRAINTS.md` §3).
- **O ciclo de assinatura pago em produção**, que só existe depois da
  troca — e com ele a marcação dos eventos `SUBSCRIPTION_*`, que exige
  payload real para ser decidida (`CONSTRAINTS.md` §2.2).
- **O primeiro pagamento real de valor baixo**, que é o gatilho escrito
  da exceção de backup (`CONSTRAINTS.md` §3).
- **Do item 6 ("outra pessoa consegue operar"):** o **registro SPF** na
  zona — valor já definido e comando pronto, barrado pelo classificador
  de permissões do ambiente, então é liberar a permissão ou colar no
  painel; os campos `⬜` que nenhuma API responde (onde a senha mora,
  qual cartão paga, contato direto); e a **pessoa número dois**, cuja
  metade com credencial — publicar de verdade e entrar no `/admin` —
  nenhum agente substitui. O resto do teste já rodou (`RUNBOOK` §10).

Tudo o mais de prontidão está fechado ou virou decisão registrada — a
lista completa, com o que era e o que passou a ser, está em
`docs/pendencias.md`.

As demais, que não bloqueiam, estão em `docs/pendencias.md`.
