# Pendências de conformidade — San Checkout

Lista completa. O `CLAUDE.md` aponta para cá e guarda só o que bloqueia a
esteira — ele é índice e cabe numa tela; esta é a lista de trabalho.

Fechar uma pendência é removê-la daqui, não riscá-la.

---

## Bloqueiam a esteira

### 🟠 Estação 5 · o pagamento em produção ainda aponta para o sandbox
A lei nova diz que o deploy da Estação 5 é "produção de verdade, não
ensaio — apontando para o ambiente real dos provedores, inclusive
pagamento", porque identificador, formato de webhook, assinatura e erro
mudam entre ambientes. Hoje `ASAAS_AMBIENTE=sandbox`.

**Virou exceção registrada em 13/09/2026**, que é o caminho que a
própria lei prevê: `CONSTRAINTS.md` §3, "Estação 5 · deploy em produção
apontando para o sandbox da Asaas". Lá está a leitura do dono (servidor
e subdomínio no ar cumprem a regra; as variáveis são decisão dele), o
plano de duas rodadas e o custo assumido.

Esta entrada fica aberta até a **segunda rodada**: variáveis em
produção, e os quatro pontos que mudam entre ambientes — identificador
de cobrança, formato do webhook, assinatura e mensagem de erro —
reconferidos um a um. O que a troca envolve está no fim deste arquivo
("Ao trocar o Northflank para produção").

### 🟡 Lei 3 · custo do scrypt no Northflank — medido em 14/09, no teto
`seguranca-san/references/senha-e-kdf.md` manda calibrar mirando 0,5 a
1 s por hash **medido no servidor real**. Medido em 14/09 por subtração
de latência (login falho em `/api/admin/sessao`, que roda uma derivação,
menos a baseline de rede de uma rota sem scrypt): login ~1,8–3,1 s,
baseline ~0,8 s → **scrypt ≈ 1,0–1,3 s** no Northflank (0,5 vCPU),
contra os ~830 ms do Render. Medida com ruído de rede (não é
microbenchmark no servidor), mas é o "no servidor real" que a lei pede.

Fica **no teto ou pouco acima** de 1 s. Não é deficit — é margem: mais
caro por tentativa é mais forte contra força bruta, o login é assíncrono
(não trava o event loop, `sessaoAdmin.js`) e é raro. **Recomendação:
manter N=2^17.** Baixar N para caber em ≤1 s enfraqueceria o hash sem
ganho real. Decisão do dono se quiser mirar o meio da faixa.

### Estação 6 · o ciclo de segurança precisa rodar sobre o Northflank
O ciclo 1 rodou em 11/09 contra o Render, em Oregon. A produção vai ficar
no Northflank, em São Paulo, com CDN na frente e outra topologia de
proxy. A Estação 6 verifica **o que está no ar** — e o que vai ficar no
ar é o outro. Repetir o ciclo lá, e comparar com o que já passou.

### 🟢 Estação 6 · ponta a ponta de seis passos (Pix) — FEITO 14/09
Os seis passos rodaram ao vivo no sandbox contra o `testemaster`, com
`ped_completo` (R$9,50; `ped_teste` de R$1 é recusado pelo piso de R$5
da Asaas — ver a entrada própria):

1. resolve pelo pull (`taxa` calculada);
2. Pix pago pelo dono → `RECEIVED`;
3. webhook processado (auditoria 9→10; cobrança → `confirmado`);
4. status público reaberto → `confirmado`, R$11,08;
5. conciliação autenticada (`X-Checkout-Key`) → `confirmado`, taxas batem;
6. estorno → `estornado`, 200 (primeira vez ao vivo; `refundController.js`).

Negativos conferidos ao vivo: chave inválida → 401; chave certa +
contratante trocado na URL → 403 (IDOR).

**Assinatura, 14/09:** a criação da sessão funciona ponta a ponta —
`POST /assinatura/testemaster/plano_anual` (R$10) devolve o `checkoutUrl`
do pop-up. Os endpoints de ciclo (`consultar/cancelar/pausar/retomar-assinatura`)
respondem certo na auth (401 sem chave) e no 404 (sem assinatura ativa).
**Falta a metade paga:** completar o cartão no pop-up para nascer a linha
em `assinaturas` e então exercitar pausar/retomar/cancelar contra uma
assinatura viva — precisa de navegador + cartão de teste, assistido pelo
dono, e será retestado pela própria MostrAí na Estação 6 dela. O ramo
assíncrono do estorno de boleto também não foi exercitado.

O contratante de teste **já existe**, cadastrado pelo dono em 13/09:

| campo | valor |
|---|---|
| id / nome | `testemaster` / TesteMaster |
| API do pedido | `https://contratante-teste.brunosanches-bhs.workers.dev` |
| webhook | a mesma URL, em `/webhook` |
| wallet de split | vazio — sem split, tudo na conta-mãe |
| métodos | Pix, boleto, cartão e assinatura (assinatura por Pix desmarcada, §2.4) |

Os três links que ele expõe, e o que cada um serve para verificar:

- `…/index.html?c=testemaster&pedido=ped_teste` — o caminho normal
- `…/index.html?c=testemaster&assinatura=plano_mensal` — recorrência
- `…/index.html?c=testemaster&pedido=ped_sem_valor` — o estado
  **indisponível**, que é o que nunca pode virar `R$ 0,00` (§4.1)

O passo do estorno se faz como na vida real — a autorização parte do
lojista de teste, com a `X-Checkout-Key` dele, porque é assim que estorno
acontece aqui (`docs/funcional.md` §8).

O `ped_sem_valor` revelou, em 13/09, dois furos de tela comprável sem
valor cobrável — corrigidos e conferidos
(`docs/erros/2026-09-13-o-guarda-de-total-olhava-o-numero-errado.md`).

---

## Abertas, não bloqueiam

### 🟡 Dois lugares menores ainda leem valor com `?? 0`
`public/js/status.js` renderiza `formatarMoeda(dados.valorCobrado)`, e a
linha de item do `pedidoHandler.js` mostra `R$ 0,00` para item sem preço
— visto na tela em 13/09, dentro do estado indisponível.

Nenhum dos dois é furo hoje: o da status lê da nossa base, onde o valor
passou pelo guarda na criação, e o do item aparece numa tela que já está
indisponível, sem nada para clicar. São o terceiro e o quarto lugar da
mesma classe dos dois erros de total, e ficam anotados como os próximos
se uma linha vier incompleta.

### 🟡 Métrica · a janela é de 24 h, não de dia civil
`GET /api/admin/metricas?dias=N` conta as últimas N×24 h. "Quantos
ontem?" hoje se responde com "nas últimas 24 horas", que é parecido e não
é a mesma coisa — em dia de pico a diferença aparece. Fechar exige
janela por data, com fuso de Brasília fixado no servidor, não no
navegador. Declarado em `docs/funcional.md` §9.

### 🟡 Direitos · não existe ticket de atendimento com auto-resposta
O canal do titular e o de suporte são e-mail (`juridico@`, `suporte@`),
agora visíveis no rodapé das duas telas do comprador. O que não existe é
protocolo: quem escreve não recebe número nem confirmação automática, e
não há prazo contado em lugar nenhum. Enquanto o volume for o de hoje,
caixa de entrada resolve; vira problema no primeiro pedido que se perder.
Declarado em `docs/funcional.md` §8.

### 🟠 Estação 6 · o limite por IP não é guarda de força bruta
Medido em 11/09: doze requisições passaram por um teto de 10/min porque o
proxy de saída alternava entre três endereços. A `X-Checkout-Key` não tem
nenhuma outra guarda além do tamanho. Declarado em `CONSTRAINTS.md` §2.7;
contador por credencial está em `docs/proximas-versoes.md`, esperando
evidência de tentativa real no log de rejeição.

### 🟠 Piso de R$5 da Asaas vs. o R$0,01 que o checkout aceita
Medido em 14/09 no ponta a ponta: gerar Pix para um pedido de R$1
(`ped_teste`, → R$2,50 com taxa) é recusado pela Asaas com "O valor da
cobrança (R$ 2,50) ... não pode ser menor que R$ 5,00". O `valorValido`
aceita de R$0,01 a R$100.000, mas a Asaas chão em **R$5,00 no valor
cobrado**. Hoje o comprador só descobre depois de preencher tudo e
clicar — mesma classe do bug de total que a RN-03 tratou, mas vindo da
Asaas. Fechar: recusar cedo (na criação e no resolver) valor cobrado
abaixo do piso da Asaas, com mensagem clara, e documentar o piso no
`API.md`. O teste de pagamento seguiu com `ped_completo` (R$9,50).

Mesma classe, achado no ciclo de assinatura (14/09): `telefoneValido`
aceita número de dígito repetido (`11999999999`), e a Asaas recusa no
cartão/assinatura com "phoneNumber inválido" (número realista passa). O
checkout aceita entrada que a Asaas depois rejeita — recusar cedo, com
mensagem própria, fecha os dois casos.

### Prontidão operacional · decisão de 14/09 — adiar, com dois gates
O dono decidiu tratar os itens de prontidão que exigem correção/criação
como atualizações futuras, enquanto o checkout fica em sandbox. Aceito
para o estado atual (um operador, sem dinheiro real). **Mas dois não são
"quando der" — travam a troca para produção:**

- **Alerta externo de queda + fila de webhook pausada (Lei 8, item 2) —
  PRIORIDADE.** O motor move dinheiro de terceiro; a Asaas pausa a fila
  após 15 falhas seguidas (§2.3) e isso só aparece por ausência. Sem um
  alerta que chega no celular, uma queda ou fila pausada em produção só
  é descoberta quando um contratante reclama = dinheiro não capturado.
  Deve existir **antes** do primeiro dinheiro real.
- **Backup com restauração testada (Lei 6) — já é gate.** Exceção §3 do
  `CONSTRAINTS.md` amarra isto exatamente ao primeiro pagamento real.

Barato e vale fazer junto na troca: **alerta de orçamento** em cada conta
paga (10 min, evita fatura surpresa). Genuinamente adiáveis enquanto for
um operador: desempenho p75 no celular e o teste da segunda pessoa com o
RUNBOOK.

### 🟢 Prontidão · e-mail do titular/suporte — CONFERIDO, funciona
Investigado em 14/09. O `dig`/DoH da sessão de nuvem não resolveu MX
(proxy do sandbox bloqueia UDP 53 e a DoH), então a medição daqui era
inconclusiva — não "sem MX". **O dono confirmou:** o MX entrega em
`admin@sancocore.com.br`, e `juridico@` e `suporte@` são alias dele. O
canal do titular/suporte recebe. O checkout não envia e-mail ao
comprador (§1.9), então SPF/DKIM/DMARC de envio seguem N/A. Nada a
fazer; fica a lição de não afirmar DNS a partir do resolver do sandbox.

### ⚪ Opção (não bloqueia) · pôr a API atrás do proxy do Cloudflare
`api.sancocore.com.br` é DNS-only (nuvem cinza): resolve direto para o
Northflank, sem o Cloudflare no caminho (resposta sem `cf-ray`). Logo, o
`…code.run` e o domínio são a mesma porta pública, e a API é protegida
só pela auth de aplicação — que está sólida. **Se** um dia se quiser
WAF, limite de borda e fechar o endereço direto, o caminho é ligar o
proxy laranja em `api.sancocore.com.br` (com SSL Full (strict) e o
certificado da origem conferido) e então um segredo injetado por
Transform Rule volta a fazer sentido. Não feito, é decisão de infra do
dono. O middleware que dependia disso foi revertido em 14/09
(`docs/erros/2026-09-14-origem-direta-alcancavel-por-fora.md`).

### 🟡 SSRF residual · o pull ainda segue redirect e não limita o tamanho do corpo
O ciclo de segurança da Estação 6 (14/09) fechou a entrada — `apiBaseUrl`
e `webhookUrl` agora exigem https e host público (RN-14, `utils/alvoDeRede.js`).
Fica o residual: `resolverPedido`/`resolverPlano` (`pedidoService.js`) fazem
`fetch` seguindo redirect e leem o corpo inteiro sem teto. Um contratante
cujo servidor seja malicioso ou comprometido poderia redirecionar para
host interno (contornando a checagem estática de host) ou devolver um
corpo enorme (OOM na instância de 512 MiB). Baixo risco hoje: o alvo é
cadastrado pelo admin e semi-confiável. Fechar de verdade pede `redirect`
controlado (sem quebrar redirect legítimo de contratante) e leitura com
teto — quando houver mais de um contratante real.

### 🟡 Latência do painel · o piso é o Supabase, não o nosso código
Medido em 13/09/2026 **do navegador do operador** (não de container na
nuvem — o ambiente do teste faz parte do teste):

| o que | tempo |
|---|---|
| rota sem banco (`/api/admin/sessao` sem token) | **20-29 ms** |
| rota 404 | 18-21 ms |
| rota com uma consulta (`/api/saude`) | 70-295 ms, mediana ~90 |

Rede e aplicação estão rápidas; **cada ida ao Supabase custa 50-270 ms** e
é barulhenta. Não é geografia: backend em Osasco e o projeto
`San_Checkout` em `sa-east-1` (São Paulo), confirmado na API do Supabase.
Não é índice faltando: o linter só acusa 5 índices **não usados** (banco
vazio), nenhuma consulta lenta. A variação bate com compute compartilhado
do plano gratuito, e o acesso é por PostgREST sobre HTTPS, não conexão
direta ao Postgres.

O código parou de **multiplicar** esse número (chamadas em paralelo,
mutação sem rebuscar a lista — 13/09). Baixar o piso em si é decisão de
custo: plano pago do Supabase dá compute dedicado. **Não fazer nada é
aceitável** enquanto o painel é de um operador só; vira problema se o
volume crescer.

### Lei 8 · erro em produção visível
Não existe alerta de serviço fora do ar nem detecção de fila pausada da
Asaas. **Parcialmente resolvido em 12/09:** o log de produção do Render e
do Northflank passou a ser legível por conector, o que era metade do
problema. Falta o alerta ativo.

### Lei 8 · eventos que chegam e só entram no log
`PAYMENT_APPROVED_BY_RISK_ANALYSIS`, os três de divergência de split e os
grupos de transferência e saldo estão marcados no painel da Asaas e caem
no ramo de não mapeado. É desenho, não descuido: a aba Webhook os mostra,
e o primeiro payload real decide o tratamento. Entrada em
`docs/proximas-versoes.md`.

### Lei 0 · a skill `revisar` nunca rodou sobre produção

### Lei 0 · cobertura de teste não alcança as rotas HTTP
As onze suítes cobrem módulos e invariantes de texto-fonte. Nenhuma sobe
o Express e exercita uma rota de ponta a ponta — o fluxo de login por
token foi exercitado assim **à mão** em 12/09/2026 (login certo, senha
errada, token adulterado, token de outro hash, teto de 5/min), e é
exatamente esse roteiro que deveria virar suíte.

### Lei 10 · a rotina de expurgo de dado pessoal não existe
Retenção de 5 anos está declarada (`docs/inventario-de-dados.md` §6), o
caminho de exclusão foi conferido contra a modelagem (§6.2), e a rotina
não foi escrita. Validação jurídica é da Estação 7.

### Migration 0004 — search_path feito; colunas ainda não
A **correção de `search_path`** das duas funções da 0002 que o linter
acusava foi aplicada em 14/09 (`supabase/migrations/0004_search_path_funcoes.sql`,
`alter function ... set search_path = public`) — o advisor de segurança
não acusa mais o WARN, só o INFO de RLS-sem-policy, que é o default-deny
intencional (backend usa service_key; anon/publishable leem zero linha,
conferido).

Ainda desenhadas e não escritas: `desativado_em` em contratantes,
`e_teste` (de mão única: só vai de teste para real) e `ambiente` em
cobranças. Entram quando o modo de teste por contratante
(`docs/proximas-versoes.md`) ou a troca para produção pedirem.

### Quando ligar o proxy laranja do Cloudflare ou outro salto
O `app.set('trust proxy', 1)` confia em **um** proxy. Verificado em
12/09 que ele continua correto com o CDN do Northflank — o limitador
trava no 11º disparo, do IP real. Ligando o proxy do Cloudflare por cima,
a contagem muda e o limitador volta a ser risco: ou todo mundo cai no
mesmo balde, ou o IP vira forjável. Ajustar junto, e o SSL/TLS do
Cloudflare em **Full (strict)**, nunca Flexible.

### Ao trocar o Northflank para produção
Três variáveis: `ASAAS_AMBIENTE` para `producao`, `ASAAS_API_KEY` e
`ASAAS_WEBHOOK_TOKEN` para os de produção. Mais: apagar o webhook do
painel sandbox da Asaas (ele acumularia 401 e pausaria a fila do
sandbox) e limpar as cobranças de teste antes de entrar dinheiro real.
`public/js/utils/api.js` e o `connect-src` do `_headers` já apontam para
`api.sancocore.com.br` desde 12/09 — trocar de host é trocar o CNAME, não
mexer no código.
