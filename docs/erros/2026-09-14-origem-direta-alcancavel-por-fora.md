# Desenhei uma defesa de borda para uma API que não tem borda

**Quando:** 14/09/2026, ciclo de segurança da Estação 6.
**Onde:** backend no Northflank; a suposição de que o Cloudflare estava
na frente de `api.sancocore.com.br`.

## O que aconteceu

Testando o perímetro, vi que a origem direta do Northflank
(`pay--san-checkout--9k49mqwtltxm.code.run`) respondia igual ao domínio
`api.sancocore.com.br`, e classifiquei como "porta dos fundos que
contorna o Cloudflare". Desenhei a correção em cima disso: um middleware
que exige um header `X-Origin-Verify` que **só o Cloudflare injetaria**
por uma Transform Rule, subido dormente (fail-open) para ligar depois.

**A suposição estava errada.** `api.sancocore.com.br` é um registro
**DNS-only** (nuvem cinza), não proxied: o Cloudflare não está no caminho
da API. O dono lembrou disso, e a evidência já estava na minha mão — as
respostas da API vinham com `server: istio-envoy` e **sem `cf-ray`**,
enquanto só o front (`checkout.sancocore.com.br`, no Pages) trazia
`cf-ray`. Eu tinha os dois lados e não comparei.

Consequências da suposição errada:

- A Transform Rule **nunca executaria** para a API (o painel do Cloudflare
  avisa exatamente isso: "pode não estar fazendo proxy para
  api.sancocore.com.br"). O header jamais seria injetado.
- Se a regra fosse implantada **e** o `ORIGIN_VERIFY_SECRET` gravado no
  Northflank, o app passaria a recusar (404) **todo** o tráfego legítimo
  — a produção inteira. Só não aconteceu porque o guard era fail-open e
  o segredo nunca foi gravado.
- O "furo" não era furo: `api.sancocore.com.br` e o `…code.run` são a
  **mesma porta pública** do Northflank. A API é pública por necessidade
  (comprador, contratante e webhook da Asaas batem nela), e quem a
  protege é a auth de aplicação — que foi verificada e está sólida
  (admin 401, sem segredo em resposta, RLS default-deny no Supabase).

## A causa raiz

Projetei um controle de borda sem confirmar que a borda estava no
caminho. "Tem Cloudflare no projeto" não é "o Cloudflare está na frente
desta rota" — o front estava proxied e a API não, e eu tratei as duas
como iguais.

## O que fica

- **Antes de desenhar qualquer defesa de borda (WAF, header injetado,
  regra de zona), provar que a borda está no caminho daquela rota** — o
  teste é uma linha: a resposta traz `cf-ray`? Sem `cf-ray`, o Cloudflare
  não está proxiando, e nada que dependa dele vale.
- É parente do erro de fechar estação contra a paráfrase da lei
  (13/09): agir sobre um modelo mental em vez da fonte medida.
- O guard `X-Origin-Verify` foi **revertido** — premissa falsa, e
  dormente já era um gatilho de outage (quem gravasse o segredo sem o
  proxy derrubaria tudo). Se um dia a API for posta atrás do proxy
  laranja de propósito, o esquema volta a fazer sentido e se reintroduz
  deliberadamente.
- A correção do `alvoDeRede.js` (https + host público em
  `apiBaseUrl`/`webhookUrl`) é independente disto e continua válida.
