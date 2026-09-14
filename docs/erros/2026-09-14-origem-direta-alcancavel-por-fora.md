# A origem do Northflank respondia direto, por fora do Cloudflare

**Quando:** 14/09/2026, ciclo de segurança da Estação 6.
**Onde:** backend no Northflank — o endereço direto da hospedagem.

## O que aconteceu

O checkout responde em `api.sancocore.com.br`, que é o Cloudflare na
frente do Northflank. O Northflank também expõe o serviço no endereço
direto dele, `pay--san-checkout--9k49mqwtltxm.code.run` — descoberto pela
API do Northflank (`ports[].dns`, `public: true`, `security.policies: []`).

Medido: `GET …code.run/api/saude` devolveu **o mesmo 200** que o domínio.
Ou seja, qualquer um que descobrisse esse host falava direto com a
origem, contornando o Cloudflare inteiro — WAF, limite de borda, e
qualquer proteção que a borda venha a aplicar. É a armadilha 1 do modelo
de Access da skill `seguranca-san` ("origem alcançável por fora"), na
camada do backend, e não estava documentada: o `CONSTRAINTS.md` §2.6 só
tratava da porta dos fundos do *front* (`*.pages.dev`).

O que **não** vazou por causa disso: a autenticação do admin é do app
(token de sessão), e responde 401 igual nos dois hosts — conferido. O
Supabase por fora também está fechado (RLS default-deny: anon e
publishable devolvem `[]`). O furo é de perímetro, não de credencial: a
origem não devia ser falável de fora do Cloudflare.

## A causa raiz

Porta pública do Northflank nasce alcançável na internet pelo DNS
`…code.run`, e ninguém fechou essa porta quando o Cloudflare entrou na
frente. "Está atrás do Cloudflare" descreve o caminho pretendido, não o
único caminho que existe.

## A correção

Segredo compartilhado que só o Cloudflare injeta: uma Transform Rule na
zona acrescenta `X-Origin-Verify: <segredo>` a toda requisição que passa
por ela; o backend recusa (404) quem chega sem o header
(`server.js`). Fail-open sem `ORIGIN_VERIFY_SECRET`, para o código subir
antes da regra sem derromper nada — a ordem de ativação está no
`RUNBOOK.md` §5.1.

Escolhido isso em vez de allowlist de IPs do Cloudflare (a lista muda e
uma entrada errada tranca a origem) e em vez de Tunnel (muda a topologia
de deploy). O segredo é reversível num clique (apagar a env).

## O que fica

- **"Atrás do Cloudflare" tem que ser testado pelo endereço direto da
  hospedagem, não pelo domínio.** O domínio sempre passa pelo Cloudflare;
  a pergunta é se existe outro caminho que não passa — e quase sempre
  existe, é o DNS que o provedor dá ao serviço.
- Vale para toda hospedagem com URL própria (`.code.run`, `.onrender.com`,
  `.railway.app`): fechar a origem faz parte de pôr o Cloudflare na
  frente, não é passo separado que se esquece.
- Conferir na varredura final (Passada 5, "a porta dos fundos") também
  pelo endereço direto do backend, não só pelo `*.pages.dev` do front.
