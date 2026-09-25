# San Checkout — SAN & CO. Pay Engine

Estrutura da San & Co. Motor de pagamento whitelabel, modelo pull, Asaas
por baixo. Segue as leis do plugin `san-co`.

> **Este arquivo é a memória do processo `san-co` no Claude Code — não
> é a única memória do repositório.** Desde 20/09/2026 existe também
> `.ia/`, a camada de memória agnóstica de agente e de metodologia:
> qualquer agente (Claude Code, Codex, Jules), com ou sem o plugin
> carregado, precisa conseguir entender e operar este projeto lendo
> `.ia/README.md`. Este `CLAUDE.md` continua sendo a fonte para "que
> skill rodar" e para o histórico dia a dia — leia os dois, comece por
> `AGENTS.md` (raiz) se você não é uma sessão Claude Code com o plugin
> já carregado. `.ia/CONTROL_PLANE.md` explica a relação entre os dois
> em detalhe.

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
| 6 Prontidão | **aberta** 14/09 | autorizada pelo dono, com escopo ampliado (`CONSTRAINTS.md` §4). Estado em 18/09: o último commit de **código** é o `3ec6454` (PR #20, a reconciliação de `valor`), e o `deployedSHA` conferido depois de cada mescla bateu com a `main`. **Qual sha está servido AGORA não se escreve aqui** — responde o comando do `RUNBOOK` §3, porque este arquivo é ele mesmo publicado: o commit que atualiza a linha muda o número que a linha afirma, e a frase nasce falsa (aconteceu duas vezes em 18/09, nos PRs #21 e #22). Migrations 0001-0010 aplicadas, árvore limpa. Conferido no ar depois da mescla, com controle negativo: `/api/saude` 200 com Supabase respondendo; `POST /api/checkout/consultar-assinatura` sem chave devolve **401** e com chave falsa devolve **401 `Chave inválida.`** (a rota existe, a guarda funciona e não vira 500) enquanto um caminho inventado devolve 404; o autoteste do controlador roda **dentro do contêiner de produção** e dá 37 checagens OK, e `dinheiroOuNulo`/`divergenciaDeValor` estão no arquivo servido — com controle negativo de que um padrão inexistente conta zero. E, depois de o dono liberar a permissão de leitura de produção, a chamada real contra três assinaturas de verdade — inclusive a do MostrAí, `QUARTERLY`/R$267,30, reparada em 16/09 — devolveu `divergenciaDeValor: null` nas três: não é controle positivo (nenhuma tinha divergência para achar), mas prova que o código roda sem erro contra o payload real da Asaas; quem provou a detecção foram as 8 sabotagens (`docs/pendencias.md`) |

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
  **Segunda rodada, no meio que importa (cartão), respondendo o que
  faltava:** aumentar (30→45) e **diminuir** (45→12) funcionam; **abaixo
  do piso de R$ 5,00 a Asaas recusa** com `400 invalid_value` e mensagem
  por meio de pagamento; `cycle` novo **não move** `nextDueDate`;
  assinatura **pausada aceita** mudança de preço; e **nenhum evento
  chegou** ao nosso receptor em nenhuma das operações — o que é
  configuração (§2.2), não incapacidade, mas dá no mesmo: quem alterar
  tem de escrever no nosso banco na mesma operação.
  **E isso escancarou um furo que já existia:** a conciliação reconfere
  `status`, `ciclo` e `proximaCobranca` contra a Asaas e **não
  reconfere `valor`** — preço mudado no painel dela deixa o nosso
  registro errado para sempre, sem sintoma. Mesma família do bug do
  `ciclo` de 15/09, e a correção de 16/09 fechou um e deixou o outro.
  RN-34, T12 do mapa, e **declarado em vez de corrigido às cegas**:
  reconciliar `valor` é deixar a Asaas mandar no número inclusive quando
  a alteração de lá foi erro humano, e a escolha entre isso e "denunciar
  a divergência" é do dono. ⚠️ **Decidido em 18/09: reconciliar — e as
  duas juntas.** Ele mandou reconciliar e deixou a recomendação comigo se
  eu discordasse; não discordo, e a recomendação foi acrescentar a
  denúncia (`divergenciaDeValor`), porque nunca foram alternativas. Documentado em `API.md` §7.5 (nova) e no
  aviso da §5.3, `INTEGRACAO.md`, `docs/funcional.md` RN-34,
  `docs/ciclo-assinatura-mapa.md` T12 e `docs/pendencias.md`.

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
  rotas montadas, em vez de a olho — a contagem de rotas e prefixos sai
  do próprio teste quando ele roda, e por isso não está escrita aqui
  (ela já estava velha em 18/09: dizia 33 e 17 quando eram 34 e 18).
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
- **Troca de plano, construída NESTA versão por ordem do dono** — **no ar desde 18/09** (PR #18, commit `5910150`), com a rota conferida em produção
  (`POST /api/checkout/trocar-plano`, `API.md` §5.6, RN-35 e RN-36,
  migration 0010). Ela nasceu de uma pergunta dele — "no Asaas não é
  possível fazer uma alteração de preço nos planos já contratados?" —
  cuja resposta minha, escrita em quatro lugares, era **falsa**; medida,
  a Asaas permite. Ele decidiu as sete regras do acerto, e elas moram no
  cabeçalho de `src/services/proporcionalService.js`, que é quem faz a
  conta (42 checagens). **O que a rota acrescenta é a ordem**, que é
  onde o dinheiro se perde: plano de destino puxado da API do
  contratante (valor e ciclo nunca do corpo), recusa cedo do que a Asaas
  recusaria depois, **acerto cobrado no cartão já salvo antes de o plano
  mudar**, e **releitura** depois do `PUT` — porque a Asaas responde
  `200` e ignora em silêncio campo que não conhece. 72 checagens de
  coreografia, com dependências injetadas, verificadas por **nove
  sabotagens** (inverter a ordem, tirar a releitura, ler o valor do
  corpo, devolver arrendamento de outra chamada).
  Duas guardas que a medição provou serem necessárias, não teóricas:
  **duas chamadas simultâneas cobrariam o acerto duas vezes** (o
  arrendamento em `assinaturas.trocando_em`, exercitado dentro do
  contêiner: 1ª ganha, 2ª não, expirado volta a poder); e **o acerto
  virava a "última cobrança da assinatura"** na conciliação — com as
  duas consultas lado a lado, sem o filtro de método vinha o acerto de
  R$ 30 onde o integrador lê o preço do plano (`API.md` §5.3), com o
  filtro vem o ciclo de R$ 160. O acerto também tem método próprio
  (`acerto_troca`) porque o `PAYMENT_CONFIRMED` dele chega ao nosso
  receptor: como `cartao`, anunciaria ao contratante a confirmação de um
  pedido com `pedidoId: null`.
  **Avisar o assinante é obrigação do contratante** — e-mail e aviso no
  site, decisão do dono (RN-35): o checkout não fala com o pagador, e é
  por isso que a resposta e o evento `plano_trocado` levam crédito,
  débito e dias restantes em vez de só o valor.

Feito em 18/09 — **ciclo de `revisar` sobre o projeto INTEIRO**, a
pedido do dono (43 arquivos de `src/`, o front, as suítes, os 11 scripts
e os 54 documentos). Três ciclos: o primeiro achou em todas as quatro
varreduras, o segundo achou um, o terceiro fechou limpo. Tudo na branch,
nada no ar ainda.

- **O processo morria calado** (Lei 8, o pedaço que faltava). A captura
  de exceção pega o que passa por rota; ficava de fora o que MATA o
  processo — promessa rejeitada sem `catch` e exceção fora de
  requisição —, e este projeto tem fire-and-forget deliberado no caminho
  do dinheiro. Sem tratador, o Node encerra e não sobra linha nenhuma em
  `erros`: um serviço reiniciando sem motivo conhecido, com o log só no
  painel do Northflank. Agora grava, loga e continua morrendo com código
  1, de propósito — seguir de pé depois de uma rejeição não observada é
  seguir num estado que ninguém sabe qual é. Suíte nova em processo
  FILHO (não dá para provar de dentro), e **a primeira versão dela
  passou sabotada**; e o comentário que eu havia escrito sobre a
  iteração anterior estava errado, corrigido contra medição: o que se
  perdia era o código de saída (saía **0**, que o orquestrador lê como
  desligamento limpo), não a gravação.
- **`pedidoId` e `planoId` não tinham teto de tamanho** — lição nº 24, e
  a guarda foi para as três funções compartilhadas por onde todo id
  passa, não para cada controlador. `express.json()` passou a declarar o
  limite em vez de herdar o default da biblioteca.
- **A guarda do `/api/admin` era provada em UMA rota das treze** — a
  ordem do `router.use` era a garantia do resto, e rota nova escrita
  acima dela nasceria pública em silêncio. É a lição nº 23 por outra
  porta; agora a suíte chama todas sem token.
- **O portão do CI não era o que os documentos prometiam**: `ci.yml`
  rodava `npm test`, e o `RUNBOOK` dizia `npm run check` — a diferença é
  a análise de sintaxe de `public/js/`, que **suíte nenhuma alcança**.
  Erro de sintaxe na tela de pagamento passava pelo portão que autoriza
  o deploy. Aqui o documento estava certo e o CI é que não era, que é a
  direção rara.
- **Documentos que mentiam**, e o pior deles não era de código:
  `docs/TESTES.md` mandava configurar `SMTP_*`/`GOOGLE_*` e prometia
  e-mail ao comprador e nota fiscal — variáveis que não existem e
  recursos **removidos do escopo em 08/09** (§1.9); o arquivo de schema
  único, que deixou de existir quando as migrations numeradas entraram,
  ainda citado por caminho em três documentos — um deles o inventário de
  dados, que é documento legal;
  `docs/plano-execucao.md` descrevendo o que fazer sem dizer que já foi
  feito; e o `RUNBOOK` dizendo 32 suítes quando eram 35. **E ao corrigir
  o `TESTES.md` eu escrevi dois nomes que não existem** (`npm run
  hash-admin`, `CHECKOUT_ADMIN_HASH`) — conferidos contra o
  `package.json` e o `.env.example` e corrigidos antes de ficar.
- **As duas checagens que teriam pego isso sozinhas, generalizadas**:
  ponteiro quebrado passou a valer para TODO documento vivo (registro de
  erro e arquivo arquivado ficam de fora, porque descrevem o mundo de
  quando foram escritos), e "N suítes" passou a ser conferido em
  qualquer documento vivo, não em duas frases conhecidas. Citação
  histórica ("o mapa dizia 18 suítes") é ignorada de propósito, com
  sabotagem nos dois sentidos provando.
- **Nenhum código morto**: todo símbolo exportado e não importado é
  costura de injeção de dependência ou superfície de autoteste. O que
  apareceu foi um conjunto fechado em dois arquivos sem comparação
  (`CICLOS_VALIDOS` × `DIAS_DO_CICLO`) — divergir daria "não foi
  possível calcular o acerto" para um plano inteiro, em silêncio.

Ainda em 18/09, as três coisas que o dono liberou de uma vez ("faça
essas coisas, o que tá esperando?"):
- **SPF na zona, no ar** (`v=spf1 include:_spf.google.com ~all`). Era a
  única pendência do item 6 que não precisava de pessoa: o valor já
  estava conferido na fonte do Google e o comando pronto, e o que faltava
  era a permissão. Conferido em **dois resolvedores independentes**
  (Google DNS e Cloudflare) com **controle negativo** num subdomínio que
  não tem TXT — sem o controle, "respondeu" não distingue registro criado
  de resolvedor mentindo em cache.
- **RN-34 decidido e construído: reconciliar `valor`, e denunciar.** A
  conciliação reconferia `status`, `ciclo` e `proximaCobranca` contra a
  Asaas e devolvia `valor` **sem reconferir** — preço alterado no painel
  dela deixava o nosso registro errado para sempre, sem sintoma, e o
  `API.md` §5.3 chegava a avisar o integrador para não confiar no campo.
  O dono mandou reconciliar e deixou a recomendação comigo se eu
  discordasse. Não discordo — quem debita o cartão é a Asaas, então o
  nosso número divergente não é opinião, é informação falsa — e a
  recomendação foi **acrescentar** a denúncia em vez de escolher entre as
  duas: o valor corrigido volta em `valor` e a divergência volta em
  `divergenciaDeValor`, porque é o contratante que fala com o assinante
  (RN-35) e corrigir calado trocaria um número errado por uma mudança
  invisível. Comparação em **centavos** (em reais, `30` e
  `30.000000000000004` seriam divergência, e a "correção" reescreveria a
  linha a cada conciliação). `API.md` §5.3 e §7.5 **invertidos**: o campo
  saiu de "não confie" para "é a verdade reconferida".
- **E a revisão dessa mudança achou um furo nela, o mais grave do dia:**
  a guarda de "isso é dinheiro utilizável?" era
  `Number.isFinite(Number(v))`, e **`Number(null)` é `0`** — enquanto
  `consultarAssinaturaNaAsaas` devolve `valor: corpo?.value ?? null`,
  isto é, `null` explícito quando a Asaas não manda `value`. Uma
  assinatura assim seria reconciliada para **R$ 0,00**: zero gravado no
  banco e zero devolvido no campo que o integrador acabara de ganhar
  permissão para confiar, mais uma divergência inventada mandando ele
  avisar o assinante de uma mudança de preço que não houve. O autoteste
  não pegou porque **o dublê omitia a chave** (`undefined` → `NaN`, que a
  guarda recusava certo) em vez de mandar `null`, que é a forma real —
  a mesma lição do dublê de pedido com o formato de item errado, de um
  dia antes. Corrigido com `dinheiroOuNulo()`, que checa o **tipo antes
  do valor**; o teste passou a rodar os dois formatos em laço e a exigir
  explicitamente `valor !== 0`. Oito sabotagens, com controle positivo, e
  a do `Number(null)` reprova com a mensagem certa ("veio 0").
  `docs/erros/2026-09-18-o-duble-omitia-a-chave-e-a-forma-real-era-null.md`.
- **Segundo ciclo de `revisar` sobre o projeto inteiro, a pedido do
  dono, mesclado e no ar** (PR #29, `486b472`). Cinco agentes em
  paralelo, cada achado relido por mim antes de contar; `services/`,
  `utils/`, `config/` e a checagem de afirmações sobre estado externo
  fecharam limpos. Corrigido: `telefone` sem validação em três rotas
  (`gerarPix`/`gerarBoleto`/`criarAssinaturaPixAutomatico`) e campos de
  endereço sem teto de tamanho — mesma classe do furo de `nome` de
  11/09; `obterResumoWebhook` sem piso em `dias` (data no futuro,
  "0 eventos" sem sintoma); **um bug real no admin**: editar um
  contratante com `metodos_habilitados` nulo ("sem restrição", inclusive
  `assinatura_pix`) estreitava silenciosamente pros 4 métodos padrão em
  qualquer salvamento, mesmo sem mexer nisso; `celulaTaxa` era a única
  interpolação em `innerHTML` do `admin.js` sem `escapar()`;
  `termos.html`/`privacidade.html` pulavam o `<h2>` (WCAG 1.3.1); mais
  dois de simplicidade (contador chumbado, dublês duplicados entre
  `acessibilidade.mjs`/`desempenho.mjs`, extraídos para
  `scripts/ajudantesNavegador.mjs`). Declarado, não corrigido por risco/
  escopo: quatro padrões de UI repetidos em `public/js/` (polling+pop-up
  de pagamento, polling de cobrança, copiar-com-fallback, toast) —
  `docs/pendencias.md`. Reverificado com `npm run acessibilidade` (0
  violações) e `npm run desempenho` depois das correções, e conferido no
  ar (`deployedSHA` = `486b472`).
- **Terceira varredura, com lente diferente: contrato ENTRE arquivos**
  (o dono pediu "furos de lógica entre os arquivos"). Dois agentes em
  paralelo — banco↔código e assinatura de função↔chamador; API↔front-end
  e webhook Asaas↔código — vieram limpos, exceto **um achado real e
  grave**: a migration 0009 (`ambiente`/`e_teste`, `not null`) e a 0010
  (`plano_anterior_id`/`trocado_em`/`trocando_em`) nunca entraram na
  lista branca do `expurgoService.js` (Lei 10), porque o retrato do
  autoteste (`COLUNAS_REAIS`) foi tirado no mesmo dia das migrations mas
  **antes** delas — a checagem que devia travar isso comparava a lista
  branca contra si mesma por um caminho indireto. Efeito: toda tentativa
  de anonimizar uma linha de `cobrancas` falharia na constraint `not
  null`, calada, porque `server.js` só somava `anonimizadas` e nunca
  olhava `relatorio.erros`. Sem dano ainda — nenhuma linha tem mais de
  cinco anos —, mas o próximo pedido de titular sobre dado velho já
  bateria nisto. Corrigido: as cinco colunas decididas (as cinco ficam —
  nenhuma identifica pessoa), `COLUNAS_REAIS` atualizado, duas
  asserções novas por coluna (o patch não toca nela, o valor sobrevive),
  sabotagem verificada; e `server.js` passou a logar e registrar (Lei 8)
  todo erro de `relatorio.erros`, fechando o mesmo buraco de visibilidade
  para qualquer coluna futura.
  `docs/erros/2026-09-18-a-migration-que-acrescentou-coluna-not-null-nao-atualizou-a-lista-branca-do-expurgo.md`.
- **Revisão dos cinco métodos de pagamento, exercitados AO VIVO contra o
  sandbox** (pedido direto do dono: "verifique se todos estão
  funcionais"). Pix e Boleto confirmados (o Boleto ainda reaproveitou
  uma cobrança pendente de um teste anterior — a idempotência
  funcionando). **Cartão avulso quebrado, achado no ato**: `POST
  /api/checkout/cartao/testemaster/ped_completo` devolveu 400 "O campo
  name só pode conter no máximo 30 caracteres" — `items[0].name` do
  `POST /v3/checkouts` da Asaas levava `pedido.descricao` cru (41
  caracteres em `ped_completo`), dado do CONTRATANTE, nunca validado
  como se fosse dado de fronteira. Assinatura por cartão testada junto
  não quebrou só porque `plano_anual` tem nome curto — a mesma falha
  esperava um plano com nome mais longo. Corrigido com
  `nomeItemAsaas()` (corta em 30, com reticências) nos dois lugares;
  o texto INTEIRO continua indo em `items[].description`, que a Asaas
  aceita sem teto (medido: 100+ caracteres passou). No mesmo teste,
  `customerData.name` (dado do PAGADOR, que passa pela nossa validação)
  foi confirmado SEM teto de tamanho — o que a Asaas recusa lá é string
  toda do mesmo caractere repetido, controle negativo de que não há um
  segundo teto escondido. Assinatura por Pix Automático confirmada
  degradando corretamente (403, não 500) quando o método não está
  habilitado — é o estado esperado, já que está desligada nesta conta
  (`CONSTRAINTS.md` §2.4).
  `docs/erros/2026-09-18-descricao-do-contratante-sem-teto-quebrava-cartao-por-inteiro.md`.

Feito em 19/09:
- **Rodapé do checkout e da tela de status citavam a identidade
  ANTIGA do operador.** `index.html` e `status.html` ainda afirmavam
  "SAN & CO. — CNPJ 68.949.029/0001-58" — a reidentificação pra pessoa
  física (CPF 552.085.198-01, `termos.html`/`privacidade.html`) tinha
  acontecido em 17/09 e tocou só os dois documentos legais, não as
  telas. Achado pelo dono: cobrança sai no CPF, então uma tela dizendo
  CNPJ é documento incorreto no ar. Corrigido nos dois arquivos, e
  travado por `tests/rodape-nao-cita-identidade-antiga.js` — nenhum
  HTML público pode citar o CNPJ antigo, e as duas telas batem com o
  CPF que `termos.html` afirma como fonte (lido dele, não chumbado no
  teste). Sabotagem verificada manualmente.
- **A pop-up da Asaas nunca fechava sozinha, e atrapalhava o próprio
  `returnUrl`.** Relatado pelo dono: depois do pagamento, a pop-up
  ficava aberta e em foco, cobrindo a janela principal — exatamente
  onde `ativarRetorno()` mostra "Pagamento Aprovado"/"Assinatura Ativa"
  e a contagem de 10s até o `returnUrl`. Já existia um `callback`
  (successUrl/cancelUrl/expiredUrl) redirecionando a pop-up pra uma
  página que se fecha sozinha, mas o próprio comentário da função já
  avisava que a Asaas "pode (ou não) redirecionar" — quem manda de
  verdade é o webhook + polling no NOSSO backend. Corrigido nos dois
  fluxos de pop-up (`cartaoHandler.js`, `assinaturaCheckoutHandler.js`):
  o `aoConfirmar` — que só dispara quando o polling confirma
  `CHECKOUT_PAID` — agora fecha a pop-up, com a mesma guarda de
  `observarFechamentoPopup` (`popup && !popup.closed`, pro caso do
  pagador já ter fechado sozinho). Travado por
  `tests/popup-fecha-ao-confirmar.js`, sabotagem verificada
  manualmente. `docs/erros/2026-09-19-a-popup-da-asaas-nunca-fechava-sozinha.md`.

Feito em 21/09/2026:
- **Troca de plano redireciona o pagador ao Checkout — reabre e
  reverte a decisão de 17/09/2026.** O dono testou o MostrAí em 20/09 e
  viu a cobrança do acerto acontecer sem o assinante ver nada; achou
  errado. Desenho fechado num relay de quatro rodadas com um chat
  externo, cada proposta verificada contra o código real antes de
  aceitar (`docs/specs/2026-09-20-troca-de-plano-redireciona-
  pagador.md`), autorizado a construir em 21/09/2026.
  `POST /trocar-plano` continua `200` imediato sem acerto a cobrar
  (rebaixamento, absorção); havendo acerto (>= R$ 5,00), passa a
  responder `202` e criar uma **intenção** (migration 0011,
  `intencoes_troca_plano`) com o retrato CONGELADO — nada é cobrado nem
  alterado na hora. O assinante aprova em `/troca#t=…` (token no
  FRAGMENTO, nunca query string; lido uma vez, mantido só em memória,
  nunca em `sessionStorage`/`localStorage` — este domínio carrega o Web
  Analytics da Cloudflare, terceiro não auditado quanto a storage). A
  cobrança de verdade só acontece depois de aprovada, pela mesma
  coreografia de sempre (cobrar → alterar na Asaas → reler → gravar),
  agora em `trocaExecucaoService.js` — com um classificador financeiro
  canônico novo (`classificacaoFinanceiraService.js`, `PAID`/
  `DECLINED_FINAL`/`UNKNOWN`) que corrige um furo pré-existente: a rota
  síncrona antiga tratava qualquer status que não fosse
  `CONFIRMED`/`RECEIVED` como recusa definitiva na hora, e não há
  confirmação medida de que a Asaas devolve algo distinguível disso
  quando o cartão é recusado de verdade — o classificador nunca deriva
  `DECLINED_FINAL` de status síncrono sozinho, só de evento de webhook
  (`PAYMENT_CREDIT_CARD_CAPTURE_REFUSED`/`PAYMENT_REPROVED_BY_RISK_
  ANALYSIS`). Um sweeper de 60s (`trocaSweeperService.js`, o intervalo
  mais curto do projeto — justificado por `PAYMENT_AUTHORIZED` não ter
  garantia de chegar por webhook) resolve o que ficou ambíguo; o
  webhook resolve pelo `charge_id` quando a Asaas confirma antes do
  sweeper. Concorrência protegida em duas camadas: CAS por transição de
  estado na intenção (`trocaIntencaoService.js`) e o arrendamento de
  sempre na assinatura (`trocando_em`); `mutation_version`
  (`assinaturas`, novo) detecta se algo mudou entre a criação da
  intenção e a aprovação — divergência vira `STALE`, nunca recálculo
  silencioso. `CONSTRAINTS.md` §3 (a exceção de CVV, cuja justificativa
  invertia de sentido — "pagador fora do circuito" virou "é a nossa
  tela que substitui a reconfirmação"), `API.md` §5.6 e
  `docs/funcional.md` (RN-35, RN-35.2 nova, RN-36) reescritos.
  Achado nesta própria revisão, antes de subir: as duas rotas novas do
  pagador não tinham `try/catch` (uma exceção viraria promessa rejeitada
  sem dono dentro de um handler assíncrono do Express — nenhuma outra
  rota deste projeto comete isso), e a retomada de um crash pelo sweeper
  não levava o documento do assinante para a cobrança nem para o aviso
  ao contratante (corrigido buscando a assinatura dentro da própria
  função de aplicação, em vez de exigir que cada chamador se lembrasse
  de anexar o campo). A auditoria de acessibilidade, rodada sobre a tela
  nova, achou de quebra um contraste insuficiente em `.status-selo--
  encerrado` que já existia em `status.html` — nenhuma tela anterior
  chegava a exibir esse selo específico no estado auditado, por isso o
  furo nunca tinha aparecido. 163 checagens novas nos módulos do
  caminho do dinheiro (classificador, intenção, execução, sweeper,
  controlador de troca reescrito, controlador de aprovação, mais a
  cobertura no `webhookController.js`), todas de sabotagem verificada.
  **Declarado, não fechado:** a recusa síncrona de cartão nunca foi
  medida ao vivo contra o sandbox (o desenho já é conservador o
  bastante para não bloquear nisso); o CLS do estado "resumo pendente"
  da tela `/troca` não foi medido com `npm run desempenho` (só o
  caminho sem token foi — medir o outro exige um token de teste de
  verdade); e `intencoes_troca_plano` ainda não tem rotina de expurgo
  própria (sem dado pessoal direto, risco menor que `cobrancas`/
  `assinaturas`, mas linhas nunca são limpas hoje). `docs/pendencias.md`,
  "Trocar de plano redireciona o pagador ao Checkout".

Feito em 22/09/2026 — auditoria técnica externa (Codex, sem acesso a
este repositório, relatório repassado pelo dono), 22 achados (AUD-001 a
AUD-022, SUS-001 a SUS-006). Verificados lendo o código real antes de
construir, e depois de construir, **a própria revisão automática do
Codex sobre a PR achou um furo dentro do meu próprio conserto** —
tratada com o mesmo rigor dos achados originais.

- **AUD-001, AUD-007, AUD-005 — três corridas no caminho da
  assinatura, corrigidas e no ar** (PR #39, `b8111e1`): Pix/Boleto
  duplicado (reserva antes de cobrar, mesmo padrão do pop-up), estorno
  duplicado (arrendamento novo, `cobrancas.estornando_em`, migration
  0013), e cancelar/pausar/retomar sem guarda nenhuma (reaproveitando o
  arrendamento que a troca de plano já tinha, `assinaturas.trocando_em`
  — ele deixou de ser exclusivo da troca). `assinaturaController.js`
  não tinha NENHUM autoteste até este dia. Detalhe em
  `docs/erros/2026-09-22-*.md` (três arquivos, um por achado).
  **A revisão automática do Codex sobre a própria PR achou o furo mais
  grave do dia**: `criarCobrancaPix` faz DUAS chamadas à Asaas (criar o
  pagamento, depois buscar o QR Code), e uma falha limpa na SEGUNDA
  liberava a reserva mesmo com o pagamento já criado — o AUD-001
  reaberto por dentro da própria correção. Corrigido com uma marca
  (`pagamentoJaCriado`) que o classificador de recusa limpa/ambígua
  respeita antes de olhar o status. Mais dois achados menores da mesma
  revisão (referência de reconciliação não persistida; falha ao
  liberar reserva ficava muda) — os três resolvidos e as threads
  fechadas antes de mesclar.
- **Os 19 achados restantes, verificados um a um** — nenhum aceito só
  pela palavra do relatório:
  - **AUD-006 (troca de plano, falha parcial) e AUD-009 (cancelar/
    pausar/retomar sem reconciliação em falha ambígua): já fechados**
    por trabalho anterior (`RECONCILIATION_REQUIRED` de 21/09, e a
    conciliação por pull de 16/09) — conferido lendo o código, não
    reconstruído.
  - **AUD-008 (retry de webhook em memória, perde na queda do
    processo) e AUD-012 (job rodaria em toda instância): já eram
    decisão registrada**, não achado novo — `INTEGRACAO.md`/`API.md`
    §4.3.6 já documentam o retry em memória, e `CONSTRAINTS.md` §2 já
    registra "não há réplica, de propósito".
  - **AUD-004 (webhook fora de ordem): real, e a doc oficial da Asaas
    confirma** — `sendType` (`SEQUENTIALLY`/`NON_SEQUENTIALLY`) é
    escolha explícita na configuração do webhook, sem padrão
    documentado. **Não dá pra saber daqui qual está configurado neste
    projeto** — declarado com o caminho de fechamento em
    `docs/pendencias.md` (conferir o painel; se `SEQUENTIALLY`, fecha
    sem tocar código).
  - **SUS-004 (deriva entre `supabase/migrations/` e o histórico do
    Supabase): real, e FECHADA.** A migration 0009 estava aplicada no
    banco (as colunas existem, em uso desde 17/09) mas ausente do
    histórico do Supabase — replay seguro (ela é inteiramente
    idempotente) resolveu, sem tocar nenhuma linha.
  - **AUD-017 (vocabulário fechado sem `check` no banco): real, e
    FECHADA — migration 0014.** `cobrancas.status`/`metodo_pagamento` e
    `assinaturas.status`/`ciclo` ganharam `check`. **A primeira
    enumeração de `cobrancas.status` estava incompleta** — lia só
    `mapearStatusPayment` e perdia dois outros vocabulários no mesmo
    arquivo (eventos de pop-up, eventos de Pix Automático). Um `select
    distinct` contra produção ANTES de aplicar achou `expirado` fora do
    conjunto — se a migration tivesse ido assim, teria falhado na hora
    ou quebrado a primeira pop-up expirada em produção, calado.
    `docs/erros/2026-09-22-quatro-colunas-de-vocabulario-fechado-sem-
    constraint-no-banco.md`.
  - **SUS-002 (`buscarOuCriarCliente`, corrida busca-então-cria) e a
    ausência de fencing token verdadeiro no arrendamento por tempo
    (`trocando_em`/`estornando_em`): declarados, não construídos.** Os
    dois são reais, mas de baixa severidade — o primeiro é qualidade de
    dado na Asaas (cliente duplicado), nunca cobrança duplicada; o
    segundo exige um processo travado por mais de 5 minutos entre
    reivindicar e escrever, cenário nunca medido como real e bem acima
    do teto de 20s que toda chamada à Asaas já tem. `docs/pendencias.md`.
  - Os oito restantes (P2/P3: versão do Node, baseline de migration,
    limitador do admin, controladores grandes, XSS sem fuzz, redação de
    log) não abriram achado novo além do que o ciclo de `revisar` de
    17-18/09 já tinha coberto ou declarado — conferidos contra o estado
    atual do código, sem reabrir o que já tinha decisão.

Feito em 25/09/2026 — **o primeiro pagamento real, e ele falhou duas
vezes sem cobrar nada** (`docs/erros/2026-09-25-primeiro-pagamento-real-pix-sem-chave-e-assinatura-com-vencimento-utc.md`).
Investigado só com leitura antes de tocar em código, como o dono mandou.
- **Pix**: o pagamento foi criado e o QR falhou — a conta de produção não
  tinha chave Pix, exigência que o sandbox não tem. O nosso defeito foi
  não gravar o `chargeId` que já tínhamos e responder 409 "sendo criada"
  ao segundo clique até o reconciliador passar. Agora a linha é
  completada na hora, a resposta é 503 `qr_indisponivel`, e o clique
  seguinte busca o QR do MESMO Pix (RN-48).
- **Assinatura**: a tela disse "Assinatura Ativa ✓" e o cartão não foi
  debitado. Duas causas: o `nextDueDate` era montado no relógio do
  processo (UTC) — às 22:26 de Brasília a Asaas recebeu "amanhã" e
  agendou o 1º ciclo (RN-49); e o `CHECKOUT_PAID` virava `confirmado`
  (RN-47). Sessão concluída agora só carimba `sessao_concluida_em`
  (migration 0016), a tela diz "processando", e a reserva dessa sessão
  nunca expira sozinha — senão, 65 min depois, abriria uma segunda
  assinatura no mesmo cartão.
- **O primeiro `SUBSCRIPTION_CREATED` real** foi homologado
  (`CONSTRAINTS.md` §2.2): a lista branca acertou os campos; a
  referência estava errada (`account` antes de `subscription`).
- Revisão em dois ciclos: o primeiro achou um furo na própria correção
  (reserva órfã amarrada sem valor, fora do alcance do reconciliador),
  o segundo fechou limpo. Seis sabotagens, todas pegas.

Falta para fechar a 6, e **nada disso é código nosso**: o ciclo de
assinatura pago em produção (exige payload real — e agora existe onde
ele vai aparecer, já que o dono marcou `SUBSCRIPTION_*` em 18/09); o
primeiro pagamento real de valor baixo, que é o gatilho escrito da
exceção de backup (§3). Tudo isso vem depois da troca da Asaas para
produção, que é do dono e que fecha a 5 sem ressalva. O MostrAí retesta
o lado dele em paralelo.

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
- O que se entrega a um contratante para ele conferir o lado dele: `docs/prompt-escopo-assinatura-mostrai.md` — o escopo de assinatura inteiro, com o que é **medido** separado do que é **decisão**, escrito para ser colado numa sessão dele
- Medição que precisa de navegador (fora do `npm test`, porque o CI não tem Chromium): `npm run acessibilidade` (axe-core, WCAG 2.2 AA) e `npm run desempenho` (`scripts/desempenho.mjs` — LCP/INP/CLS num funil de celular, mais o orçamento de 30 KB por imagem)
- Testes: `tests/` — `npm test` roda as 61 suítes; `npm run check` roda a análise de sintaxe de todo JS (inclusive `public/js/`, que os testes não alcançam) e depois as suítes. **Este número é conferido por teste** (`tests/o-que-os-documentos-afirmam.js`): ele já esteve errado três vezes em 17/09/2026, e corrigir à mão não impedia a próxima
- Imagem de produção: `Dockerfile` · CI: `.github/workflows/`

## Mesclar é decisão tomada
**O dono autorizou, em 18/09/2026, mesclar na `main` sem pedir, sempre
que estiver pronto** — e mesclar aqui é publicar, porque a `main` vai
para produção sozinha. A porta continua sendo o **CI verde**
(`RUNBOOK` §3), não uma pessoa. O que ele dispensou foi a pergunta
"posso mesclar?"; a lista curta da skill `leis` (caminho de dinheiro,
segredo, migration destrutiva, contrato que outro projeto consome)
continua exigindo autorização para CONSTRUIR.

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
  troca — e com ele o **tratamento em código** dos eventos
  `SUBSCRIPTION_*`, que exige payload real para ser escrito
  (`CONSTRAINTS.md` §2.2). A **marcação** deles já não bloqueia mais:
  o dono marcou o grupo inteiro em 18/09/2026 — ver abaixo.
- **O primeiro pagamento real de valor baixo**, que é o gatilho escrito
  da exceção de backup (`CONSTRAINTS.md` §3).
- **Do item 6 ("outra pessoa consegue operar"):** os campos `⬜` que
  nenhuma API responde (onde a senha mora, qual cartão paga, contato
  direto) — o dono vai resolver por conta própria depois de fechar o
  MostrAí e o checkout.
  ✅ **O registro SPF saiu daqui em 18/09**: o dono liberou a permissão e
  o TXT `v=spf1 include:_spf.google.com ~all` está no ar na raiz da zona,
  conferido em dois resolvedores independentes (Google e Cloudflare) com
  controle negativo num subdomínio.
  🔁 **A pessoa número dois virou atualização futura em 18/09**, por
  decisão do dono — não existe hoje e vai levar um tempo
  (`docs/proximas-versoes.md`). O resto do teste do `RUNBOOK` §10 já
  rodou com um agente sem contexto; o que falta é a metade com
  credencial, que nenhum agente substitui.
  ✅ **A marcação de `SUBSCRIPTION_*` saiu daqui em 18/09**: o dono
  marcou o grupo inteiro no painel (as 7 famílias, `CONSTRAINTS.md`
  §2.2), junto com `INTERNAL_TRANSFER_CREDIT`/`_DEBIT` (achado
  faltando) e desmarcou `PAYMENT_CHECKOUT_VIEWED` (achado sobrando) —
  as duas divergências que uma conferência contra o painel real achou
  no mesmo dia. O que falta é só o **tratamento em código**, que segue
  no item acima porque exige o primeiro payload real.

Tudo o mais de prontidão está fechado ou virou decisão registrada — a
lista completa, com o que era e o que passou a ser, está em
`docs/pendencias.md`.

As demais, que não bloqueiam, estão em `docs/pendencias.md`.
