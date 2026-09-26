# Current Handoff

## SAN CHECKOUT V1 = ENCERRADO (26/09/2026)

Leitura de cinco minutos para qualquer agente futuro.

| Pergunta | Resposta |
|---|---|
| **O que é** | O checkout e a infraestrutura de pagamento **internos**, usados só pelos **projetos próprios** do operador. Hoje são o MostrAí e o contratante de teste `testemaster`. A Asaas fica por baixo. |
| **O que não é** | Não é plataforma comercial para lojistas externos. A V1 não tem marketplace, onboarding de terceiros, operação multiempresa externa, recebimento oferecido como serviço, nem ambição de PSP ou gateway para terceiros (`CONSTRAINTS.md` §1.12). |
| **Onde está** | Em **produção**, operacional e documentado:<br>• API: `https://api.sancocore.com.br`, no Northflank, região brasileira.<br>• Telas: `https://checkout.sancocore.com.br`, no Cloudflare Pages.<br>• Banco: Supabase `sa-east-1`.<br>• Asaas em **produção** desde 25/09/2026. |
| **Qual é o estado** | **V1 finalizada.** As estações 1 a 7 estão fechadas. A 7 fechou com a varredura final dispensada pelo dono, registrada como exceção em `CONSTRAINTS.md` §3. Nada está em andamento e nada bloqueia. |
| **O que é futuro** | A formalização empresarial e uma **V2**, que só nasce por decisão formal do dono (seção "A V2"). |
| **Quando reabrir** | Somente em cinco casos:<br>• bug real;<br>• nova necessidade de negócio;<br>• alteração regulatória relevante;<br>• formalização (pessoa jurídica);<br>• início da V2. |

> **Não evoluir silenciosamente a V1 para V2.** A V2 é evolução
> substancial, com decisão formal do dono e estação nova. Não é uma
> série de patches sobre a V1.

## Updated

2026-09-26 (UTC), no encerramento formal da V1.

## Agent

Claude Code

## Branch

Nenhum trabalho em andamento. A branch de trabalho
`claude/nifty-meitner-4ffp9s` fechou com a mescla do PR #64. **O
próximo agente começa da `main`.** Se a branch ainda existir, ela
contém só história já mesclada.

## Current objective

Nenhum. A V1 cumpriu o objetivo: ser uma infraestrutura interna de
pagamento **segura, previsível, documentada, recuperável, auditável e
operacionalmente simples** para os projetos próprios do operador.

## Current state

- **Produção:** o commit servido é o merge do PR #64. Reconfirme pelo
  comando em "Verification commands".
- **Documentos legais vigentes:** Termos de Uso v3 e Política de
  Privacidade v4, desde 26/09/2026. As versões anteriores estão
  arquivadas byte a byte em `docs/legal-arquivado/`.
- **Inventário de dados:** conferido campo a campo em 26/09/2026
  (`docs/inventario-de-dados.md`).
- **Referência operacional da V1:** `RUNBOOK.md`. Cobre onde roda, como
  sobe, como reverter, saúde, banco, webhook, incidente, recuperação,
  fornecedores e limitações deliberadas.

### Escopo funcional concluído na V1

- Checkout público, Pix, cartão (até 12x) e boleto.
- Assinaturas com ciclos, cancelamento, pausa e retomada.
- Estorno integral e parcial, e chargeback no escopo suportado.
- Integração com a Asaas: webhooks com inbox durável, outbox, conciliação
  e workers.
- Segurança, banco e RLS; migrations `0001` a `0020`.
- Produção, health e recuperação operacional.
- Testes (82 suítes) e CI.
- `RUNBOOK`, LGPD, Termos, Política, inventário e histórico das versões
  legais.

### Limitação deliberada

**Assinatura de cartão já paga não tem alteração direta de valor.**
`POST /trocar-plano` responde `409 troca_de_valor_nao_suportada` (ADR-011,
RN-35.4). Um valor novo exige cancelar e contratar de novo. Isso **não**
impede mudar o preço-base para contratações futuras. Não tentar
contornar.

## O que ficou, e por que nada disso reabre a V1

Estes itens pertencem ao operador ou a fases futuras. **Nenhum autoriza
trabalho sem pedido do dono.**

**POST_V1_HARDENING** — melhorias técnicas conhecidas:

- **Expurgo de `intencoes_troca_plano`.** O prazo já foi decidido: 90
  dias depois de vencer sem cobrança, 5 anos com cobrança. A tabela tem
  0 linhas, e a troca por cartão está recusada.
  Referência: `docs/inventario-de-dados.md` §1.3.
- **`clientes_asaas` no expurgo**, pelo prazo e a pedido do titular.
  Opcionalmente, HMAC no lugar do SHA-256 puro. Enquanto não houver
  código, o pedido do titular inclui apagar a linha à mão.
  Referência: `docs/inventario-de-dados.md` §6.3.
- **Tratamento em código dos eventos `SUBSCRIPTION_*`.** A marcação no
  painel já existe. O código espera o próximo ciclo pago real.
- **Rotação de `ASAAS_WEBHOOK_TOKEN` sem janela de risco.**
- As demais entradas "Abertas, não bloqueiam" de `docs/pendencias.md`.

**OWNER_DECISION** — decisões do dono:

- **Gravar o aceite dos documentos**, com versão e hash do texto.
  Hoje o sistema prova qual versão estava vigente na data da transação,
  mas não que o Pagador marcou a caixa (`docs/inventario-de-dados.md`
  §8).
- **Proteção de branch da `main`**, que é configuração do GitHub.
- **O CPF como oráculo de "tem assinatura"**, que é decisão de produto.

**OWNER_MANUAL_TESTS** — testes reais controlados, do dono:

- estorno de compra parcelada;
- o que a Asaas faz depois de negar o estorno de um boleto;
- o modo estrito do IP do webhook;
- o próximo ciclo pago de assinatura;
- o `sendType` do webhook no painel da Asaas (AUD-004);
- os testes integrados com os outros projetos.

**EXTERNAL_VALIDATIONS** — profissionais de fora:

- **Contador:** a emissão fiscal pela taxa do checkout, e a contagem
  fiscal dos 5 anos (CTN, art. 173, I).
- **Advogado, se o dono quiser:** as ressalvas de responsabilidade
  diante do CDC, um prazo menor para os dados de contato e o
  autoenquadramento como agente de pequeno porte.
- O **regulatório** não é pendência da V1. É pré-requisito da V2.

Relatório completo: `docs/CONSOLIDACAO_JURIDICA_ESTACAO_7_2026-09-26.md`.

## A V2

Só nasce se o Checkout for atender terceiros, outras pessoas jurídicas,
comerciantes independentes ou vários recebedores externos. Antes disso
tem de haver:

1. **decisão formal do dono** e uma versão nova aberta na **Estação 1**
   (Opus, esforço alto), com spec novo;
2. revisão societária, contábil, fiscal, jurídica, regulatória, de
   segurança, arquitetura, infraestrutura, operação, contratos e da
   experiência multiempresa;
3. só então, e dentro dela: split, subcontas reais, governança,
   contratos B2B, compliance, arquitetura de escala e a revisão completa
   do fluxo financeiro.

As ideias guardadas para depois estão em `docs/proximas-versoes.md`.
Entrada ali é ideia, não autorização.

Entre versões, o projeto fica em **estado de coleta** (skill `leis`): a
sessão recebe e compila ideias, mas não constrói nem abre estação.
Bug, falha de segurança, documento que virou mentira e obrigação legal
não são ideias: corrigem-se na hora, como reabertura da V1.

## Entrega de manutenção

**O que renova ou vence, e é só do dono:**

- o domínio `sancocore.com.br` vence em **31/08/2027**, no registro.br;
- as contas Asaas, Northflank, Supabase, Cloudflare, Google Workspace e
  GitHub, cujo inventário e rotação de segredos estão no `RUNBOOK` §1.1
  e §1.2;
- os campos `⬜` do `RUNBOOK` §1.1, que ficam com o dono, fora do
  repositório.

**A reenviar na conversa de manutenção do plugin `san-co`** (skill
`leis`, "Fecho da esteira"):

- `docs/erros/` inteira;
- `CONSTRAINTS.md`;
- `CLAUDE.md`;
- `API.md`;
- `docs/specs/2026-09-11-san-checkout.md`, porque o escopo revelou uma
  pergunta que as fases não fazem (a do dinheiro de terceiro, abaixo).

**As três linhas:**

1. **Lei violada mais de uma vez:** a Lei 10, com documento que virou
   mentira. A política nomeou o Render depois da migração, este handoff
   parou duas vezes, e o inventário chamou de irreversível um hash de CPF
   sem sal.
2. **Estações que fecharam com exceção:**
   - a 5, com produção apontando para o sandbox (exceção fechada em
     26/09);
   - a 6, fechada por decisão do dono, com três itens passados à 7;
   - a 7, com a varredura final dispensada (`CONSTRAINTS.md` §3).
3. **Regras que faltaram:**
   - o inventário da skill `legal` não manda conferir os terceiros que
     o navegador do visitante chama sozinho, e por isso o Google Fonts
     e o ViaCEP ficaram sem declaração até 26/09;
   - a esteira não pergunta **de quem é o dinheiro** que passa pela
     conta, e a distinção entre V1 e V2 só apareceu no encerramento.

## Files changed

Encerramento (junto com o PR #64):

- `.ia/HANDOFF.md`, `.ia/PROJECT_STATE.md` e `.ia/TODO.md`;
- `CLAUDE.md`;
- `docs/pendencias.md` e `docs/proximas-versoes.md`;
- `CONSTRAINTS.md`: §1.12, a exceção da Estação 7 em §3 e o item
  "sem split".

Nenhum código funcional foi alterado no encerramento.

## External systems touched

Nenhum no encerramento, além da mescla do PR #64, que publica pela
`main` como toda mescla.

## Deployments

A mescla do PR #64 publica os documentos legais vigentes. O backend não
teve mudança de código desde `d1af4a5`.

## Database changes

Nenhuma. A última migration é a `0020`, aplicada e validada em
26/09/2026.

## What is working

A V1 inteira, dentro do escopo acima. Saúde em
`https://api.sancocore.com.br/api/saude`: `200` com
`workersAtrasados: []` é o normal.

## What is not working

Nada conhecido como quebrado. As limitações são deliberadas e estão
registradas (`CONSTRAINTS.md`).

## Next task

Nenhuma. O próximo trabalho nasce de uma das cinco causas de
reabertura, ou da decisão formal de abrir a V2.

## Known risks

Ver `.ia/RISKS.md`. O risco que define a fronteira entre V1 e V2 é
regulatório: dinheiro de terceiro passando pela conta pessoa física do
operador (`CONSTRAINTS.md` §1.12 e §3, "sem split").

## Do not undo

- Não cadastrar contratante que não seja projeto próprio do operador
  (`CONSTRAINTS.md` §1.12).
- Não construir split, subconta ou multiempresa "para preparar o
  futuro".
- Não contornar a recusa de troca de valor em assinatura de cartão
  (ADR-011).
- Não reutilizar o CNPJ da v1 em documento vigente. Ele pertence a
  outra atividade.
- Não reescrever `docs/legal-arquivado/`: é o texto exato que esteve
  publicado.
- Não reverter a autorização de merge com CI verde (`CLAUDE.md`,
  "Mesclar é decisão tomada").
- Não editar o plugin `san-co`. Só a sessão de manutenção do plugin
  edita skill.

## Useful commands

```bash
git status --short && git log -5 --oneline
npm run check
curl -sS https://api.sancocore.com.br/api/saude
northflank get service --projectId san-checkout --serviceId san-checkout --output json
```

## Verification commands

```bash
# o commit servido é o mesmo da main
git fetch -q origin main && git rev-parse origin/main
northflank get service --projectId san-checkout --serviceId san-checkout --output json | \
  python3 -c "import json,sys; print(json.load(sys.stdin)['deployment']['internal']['deployedSHA'])"

# documentos vigentes no ar
curl -sS https://checkout.sancocore.com.br/termos | grep -o 'Versão 3[^<]*'
curl -sS https://checkout.sancocore.com.br/privacidade | grep -o 'Versão 4[^<]*'

# nenhum segredo em .ia/
grep -rniE "api[_-]?key\s*=\s*['\"a-z0-9]{10,}|-----BEGIN|sk_live|sk_test" .ia/ || echo "limpo"
```

## Notes for next agent

Se você chegou aqui para "melhorar" alguma coisa, confira antes se é uma
das cinco causas de reabertura. Não sendo, registre a ideia em
`docs/proximas-versoes.md` e pare: é assim que a V1 continua simples.

A história completa, dia a dia, está em `CLAUDE.md`. O estado
verificável está em `.ia/PROJECT_STATE.md`.
