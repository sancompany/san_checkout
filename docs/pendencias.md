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

**Decidido pelo dono em 13/09/2026: a troca acontece depois de a Estação
6 fechar.** A prontidão inteira — teste de ponta a ponta e ciclo de
segurança — roda no sandbox, onde errar não custa dinheiro, e o ambiente
real entra com o sistema já verificado. O que a troca envolve está no fim
deste arquivo ("Ao trocar o Northflank para produção").

**O custo assumido, escrito para não virar surpresa:** o que muda entre
sandbox e produção não terá passado pelo ciclo — identificador de
cobrança, formato do webhook, assinatura e mensagem de erro. Depois da
troca, os pontos que dependem desses quatro precisam ser reconferidos um
a um contra o ambiente real, mesmo com a Estação 6 fechada. Não é repetir
o ciclo; é conferir a costura.

Enquanto não trocar, a Estação 5 fica **no ar com ressalva registrada**.

### 🟡 Lei 3 · o custo do scrypt nunca foi medido no servidor de hoje
`seguranca-san/references/senha-e-kdf.md` manda calibrar mirando 0,5 a
1 s por hash **medido no servidor real**. Os ~830 ms conhecidos são do
Render. Refazer no Northflank (0,5 vCPU) e ajustar N se sair da faixa.
Exceção registrada em `CONSTRAINTS.md` (Lei 3 · scrypt no lugar de
Argon2id) já aponta esta lacuna.

### Estação 6 · o ciclo de segurança precisa rodar sobre o Northflank
O ciclo 1 rodou em 11/09 contra o Render, em Oregon. A produção vai ficar
no Northflank, em São Paulo, com CDN na frente e outra topologia de
proxy. A Estação 6 verifica **o que está no ar** — e o que vai ficar no
ar é o outro. Repetir o ciclo lá, e comparar com o que já passou.

### 🔴 Estação 6 · o teste de ponta a ponta de seis passos
Exigido pela skill `checkout`, **antes** do ciclo de segurança: pedido de
valor baixo, pagar por Pix, conferir webhook, reabrir a página de status,
conciliar, estornar. Nunca foi feito, e é o **próximo item da fila**.

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

**Passo 1 feito em 13/09**, e ele já pagou o próprio custo: os três links
resolvem pelo modelo pull, e o `ped_sem_valor` revelou dois furos de
tela comprável sem valor cobrável — corrigidos no mesmo dia
(`docs/erros/2026-09-13-o-guarda-de-total-olhava-o-numero-errado.md`).
**A correção só vale em produção depois do deploy**; até lá, o que está
no ar ainda mostra R$ 1,49 de total para o pedido sem preço.

Passos 2 a 6 pendentes: pagar o Pix no sandbox (é o dono quem paga),
conferir o webhook, reabrir o status, conciliar e estornar.

---

## Abertas, não bloqueiam

### 🟠 A chave do contratante de teste saiu do cofre
Em 13/09 a `X-Checkout-Key` do `testemaster` foi colada numa conversa
para pedir ajuda com a configuração do Worker. Não está em arquivo nenhum
deste repositório, e é chave de contratante **de teste em sandbox** — o
alcance é o pedido de mentira. Ainda assim, o caminho declarado aqui é
revogar, não esquecer (é a mesma regra do `seguranca.yml`): gerar valor
novo, trocar nos dois lados (painel do checkout e secret `CHECKOUT_KEY`
do Worker) e nunca reaproveitar o exposto. Fechar esta pendência é ter
feito a troca.

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

### 🔴 Lei 5 · cache de 4 horas em JS e CSS
O `Cache-Control: max-age=0` do `_headers` vale para o HTML e **é
sobreposto pelo Cloudflare Pages nos assets** — medido ao vivo em
11/09/2026. Depois de todo deploy que mexa em JS ou CSS, o navegador pode
rodar HTML novo com script velho por até 4h. Já fez correção certa
parecer errada três vezes no mesmo dia.

**Correção:** Cache Rule na zona (Regras → Cache Rules) com *Browser TTL*
zero em `/js/*` e `/css/*`. Configuração de painel, plano gratuito.
**Contorno hoje:** Ctrl+Shift+R depois do deploy.
**Deliberadamente NÃO feito:** o paliativo de `?v=` nas tags — exige
lembrar de incrementar a cada mudança, e ritual que se esquece é proteção
de mentira.

### 🟠 Estação 6 · o limite por IP não é guarda de força bruta
Medido em 11/09: doze requisições passaram por um teto de 10/min porque o
proxy de saída alternava entre três endereços. A `X-Checkout-Key` não tem
nenhuma outra guarda além do tamanho. Declarado em `CONSTRAINTS.md` §2.7;
contador por credencial está em `docs/proximas-versoes.md`, esperando
evidência de tentativa real no log de rejeição.

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

### Migration 0004, desenhada e não escrita
`desativado_em` em contratantes, `e_teste` (de mão única: só vai de teste
para real), `ambiente` em cobranças, e a correção de `search_path` nas
duas funções da 0002 que o linter do Supabase acusou.

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
