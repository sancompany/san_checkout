# RUNBOOK — San Checkout

Como operar, reverter, restaurar e responder a incidente. Escrito em
13/09/2026, na auditoria retrógrada da Estação 3.

Este arquivo diz o que **é verdade hoje**. Onde algo não foi testado,
está escrito que não foi — item não testado é hipótese, e hipótese em
runbook é pior que ausência.

---

## 1. Onde as coisas rodam

| peça | onde | endereço |
|---|---|---|
| Backend (Node/Express) | Northflank, `southamerica-east` (Osasco) | `https://api.sancocore.com.br` |
| Frontend estático | Cloudflare Pages, projeto `san-checkout` | `https://checkout.sancocore.com.br` |
| Banco | Supabase, projeto `San_Checkout`, `sa-east-1` (São Paulo) | ref `zacuaroarelaqnzjjlcz` |
| Pagamento | Asaas — **sandbox** hoje (`ASAAS_AMBIENTE`) | `api-sandbox.asaas.com` |
| Porta do `/admin` | Cloudflare Access, equipe `fancy-dawn-740a` | política "Somente o operador" |
| Repositório | GitHub `sancompany/san_checkout`, branch `main` | — |
| Ping externo | cron-job.org, a cada 10 min em `/api/saude` | mantém Supabase ativo |

Aplicação e banco na mesma região — medido em 13/09/2026 do navegador do
operador: rota sem banco 20-29 ms, rota com uma consulta 70-295 ms.

## 2. Está no ar?

```
curl -sS https://api.sancocore.com.br/api/saude
```

Resposta boa: `{"status":"ok","chaveAsaasConfigurada":true,`
`"supabaseConfigurado":true,"supabaseRespondendo":true,`
`"alertasChaveAsaas":[]}`

- `supabaseRespondendo: false` → banco fora ou pausado por inatividade.
- `alertasChaveAsaas` não vazio → a chave da Asaas está expirando ou foi
  apagada. Gerar nova no painel da Asaas e trocar `ASAAS_API_KEY` **no
  Northflank**.

## 3. Publicar

`git push` na `main` publica nos dois lugares, sozinho: Northflank
(CI+CD do GitHub) e Cloudflare Pages.

**A porta é o CI verde, não uma pessoa.** Dois workflows:
`testes` (`npm test`) e `Segurança` (dependências, segredos, análise
estática).

**Depois de todo deploy que mexa em JS ou CSS: Ctrl+Shift+R.** O
Cloudflare Pages sobrepõe o `Cache-Control` dos assets com TTL de 4h —
pendência aberta em `docs/pendencias.md`. Já fez correção certa parecer
errada três vezes no mesmo dia.

## 4. Reverter

**Caminho certo e testado: reverter no git.**

```
git revert <sha-ruim>     # cria um commit que desfaz, sem reescrever histórico
git push
```

O push republica os dois lados. Tempo: o CI leva ~15 s (testes) e ~35 s
(segurança); o build do Northflank e o do Pages vêm depois.
**Tempo total de volta ao ar: não medido** — medir na próxima reversão
real e escrever aqui.

**Nunca `git reset --force` na `main`.** Este repositório já perdeu
trabalho uma vez por reescrita de histórico
(`docs/erros/2026-09-11-filter-repo-apagou-trabalho-nao-commitado.md`).

**Rollback pelo painel do Northflank** (redeploy de um build anterior)
existe como caminho alternativo e **não foi testado neste projeto**. Não
usar como primeira opção sem testar antes, fora de incidente.

## 5. Variável de ambiente

Nomes em `.env.example` (nunca valores). A ordem tem duas metades e ela
importa:

1. A variável nova existe **antes** do código que a usa subir.
2. A antiga só sai **depois** que o código que a usava saiu do ar.

Trocar na ordem errada derruba a produção entre um passo e o outro — já
aconteceu (`docs/erros/2026-09-11-variavel-trocada-antes-do-codigo-subir.md`).

Valor com `$`, crase, contrabarra ou aspas vai **codificado em base64**;
o painel trata `$` como substituição de shell e trunca o resto
(`docs/erros/2026-09-11-cifrao-em-variavel-de-ambiente.md`).

## 6. Restaurar o banco

**NÃO HÁ BACKUP AUTOMÁTICO.** O plano gratuito do Supabase não faz, e
isso é exceção registrada com gatilho no `CONSTRAINTS.md` (Lei 6): o
gatilho é a primeira cobrança real. Enquanto o banco só tem dado de
teste, o custo de perdê-lo é reescrever o schema a partir de
`supabase/migrations/`.

Reconstruir do zero: aplicar `supabase/migrations/0001` a `0003`, na
ordem, pelo editor SQL do Supabase.

**Restauração nunca foi exercitada.** Enquanto não for, é backup
hipotético — e é isso que a Lei 6 chama de não conforme.

## 7. Mudar schema

Pelo **editor do Supabase**, e a mudança vira migration numerada nova em
`supabase/migrations/`. Migration aplicada nunca é editada; corrige-se
com outra. Coluna acrescentada depois da primeira ida a produção precisa
de `alter table ... add column if not exists` no corpo executável — em
comentário não roda
(`docs/erros/2026-09-11-coluna-nao-criada-por-create-table-if-not-exists.md`).

Nunca alterar schema por conexão direta com `DATABASE_URL`.

## 8. Incidente

**A fila de webhook da Asaas pausa depois de 15 falhas seguidas.** É o
incidente mais provável, e o mais silencioso: as cobranças continuam
sendo pagas e nenhuma confirmação chega.

1. Conferir a aba **Webhook** do painel admin (eventos recebidos, e
   quantos ficaram `nao_tratado`).
2. Conferir no painel da Asaas se a fila está pausada, e reativar.
3. Conciliar o que passou: `API.md` §5.2 (pedido) e §5.3 (assinatura).
   As duas rotas reconsultam a Asaas e corrigem o banco — enxergam
   pagamento que o webhook perdeu.

**Perdi o acesso ao `/admin`:**
- Barrado pelo Cloudflare Access → painel Zero Trust, com a conta
  Cloudflare. Não há dependência circular entre as duas camadas.
- Usuário/senha recusados → gerar hash novo com
  `node scripts/gerar-hash-admin.js` (rodar na raiz do projeto) e trocar
  `CHECKOUT_ADMIN_PASS_HASH` no Northflank. Trocar a senha **invalida
  todas as sessões abertas**, por construção.

**Vazou segredo:** revogar, sempre. Nunca só apagar do histórico —
reescrever histórico não alcança clone, fork nem cache de quem já
baixou.

## 9. O que este runbook ainda não tem

Entra na Estação 6 (prontidão operacional), e está em
`docs/pendencias.md`:

- alerta externo de "caiu" que chegue ao celular;
- captura de exceção com contexto da requisição;
- monitor que avise quando a tarefa agendada **não** rodou;
- alerta de orçamento nas contas pagas;
- teste de restauração do banco;
- tempo de volta ao ar medido numa reversão real;
- leitura deste arquivo por uma segunda pessoa, que é o teste de que ele
  serve.
