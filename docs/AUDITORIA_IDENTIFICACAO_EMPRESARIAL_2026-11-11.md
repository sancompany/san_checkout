# Auditoria e padronização da identificação empresarial — 11/11/2026

Pedido do dono: padronizar a identificação empresarial do Checkout SAN
com o MEI dele, sem mexer na caracterização jurídica/operacional do
produto, sem tocar na Asaas e sem merge/deploy.

| dado oficial | valor |
|---|---|
| Nome empresarial | **68.949.029 BRUNO HENRIQUE SANCHES** |
| CNPJ | **68.949.029/0001-58** |
| Natureza jurídica | Empresário Individual — MEI |
| Titular e responsável legal | **Bruno Henrique Sanches** |
| Marcas (inalteradas) | Checkout SAN (produto), SAN & CO. (identidade institucional) |

Consulta pública do CNPJ (BrasilAPI, 11/11/2026): ativo, aberto em
03/09/2026, CNAE 8230001, bairro Alto, CEP 15997-078, Matão/SP. Rua e
número vieram vazios; o endereço publicado é o informado pelo dono e
está marcado para confirmação.

## Decisão a registrar: reversão de 26/09/2026

Em 26/09/2026 o dono decidiu que o CNPJ "pertencia a outra atividade" e
que os documentos identificariam o CPF. A formalização no MEI **reverte**
isso. A reversão está datada em `CONSTRAINTS.md` (Lei 10, §3),
`.ia/DECISIONS.md` (ADR-006 anotado, ADR-012 novo), `.ia/HANDOFF.md`,
`CLAUDE.md` e `docs/legal-arquivado/README.md`. O histórico não foi
apagado.

## Auditoria — onde cada coisa estava

| superfície | achado | tratamento |
|---|---|---|
| Rodapé do checkout, status e troca de plano | "SAN & CO. — CPF 552.085.198-01" nas três telas | **atualizado** para nome empresarial + CNPJ |
| Termos de Uso | operador = pessoa física com CPF | **v4**: MEI, CNPJ, titular, endereço; CPF removido |
| Política de Privacidade | controlador = pessoa física com CPF; item 20.3 afirmava que o art. 15 do Marco Civil não se aplica | **v5**: MEI; 20.3 não afirma mais inaplicabilidade |
| Documentos/recibos | o sistema **não emite** recibo nem nota; o checkout não fala com o pagador | nada a alterar |
| E-mails automáticos | **não existem** (sem biblioteca de e-mail em `src/`) | nada a alterar |
| Identificação do recebedor na cobrança | vem do **cadastro da Asaas**, não do nosso código; nenhum payload carrega identidade do operador | **dependência manual** (abaixo) |
| Integração Asaas, contratantes, chaves, webhooks, split, contas | só identificadores e credenciais; sem nome empresarial | **intocados** |
| `API.md` §2.0 e nota do split | descreviam pessoa física, "sem transição" | **reescritos** |
| `docs/inventario-de-dados.md` | "O CPF do operador é publicado"; Marco Civil "não se aplica" | **reescritos** (§4.1, §6) |
| `CONSTRAINTS.md`, `RUNBOOK.md`, `.ia/*`, `docs/pendencias.md` | "pessoa física", "não há transição" | **atualizados** com nota datada |
| Teste de rodapé | travava o CPF | **reescrito**: Termos = Política = rodapés, CNPJ com dígitos válidos, nenhum CPF em HTML público |
| `docs/erros/`, `docs/legal-arquivado/*.html`, relatórios datados, narrativa do `CLAUDE.md` | descrevem o mundo da época | **mantidos** de propósito |
| CPF real como fixture (`erroService`, `expurgoService`, `scripts/expurgo.mjs`, exemplos de `API.md`/`funcional.md`) | não é identificação do operador | **mantido**; recomendação de troca por CPF sintético |

## Entrega, na ordem pedida

### 1. Arquivos modificados

`public/termos.html`, `public/privacidade.html`, `public/index.html`,
`public/status.html`, `public/troca.html`,
`tests/rodape-nao-cita-identidade-antiga.js`, `tests/executar.js`
(comentário), `API.md`, `CONSTRAINTS.md`, `CLAUDE.md`, `RUNBOOK.md`,
`.ia/DECISIONS.md`, `.ia/HANDOFF.md`, `.ia/PROJECT_STATE.md`,
`docs/inventario-de-dados.md`, `docs/pendencias.md`,
`docs/legal-arquivado/README.md`. **Novos:** este relatório e as cópias
exatas `docs/legal-arquivado/termos-v3-pf-2026-09.html` e
`privacidade-v4-pf-2026-09.html`.

### 2. Onde o nome empresarial foi atualizado

Termos §1.1 e assinatura; Política (bloco do controlador e assinatura);
rodapé de `index.html`, `status.html` e `troca.html`; `API.md` §2.0.

### 3. Onde o nome pessoal foi mantido (corretamente)

Como **titular e responsável legal** nos Termos §1.1 e na assinatura, e
no bloco do controlador da Política e na assinatura. Também dentro do
próprio nome empresarial (o nome do MEI embute o nome civil). Nas
marcas, **não** foi substituído: Checkout SAN e SAN & CO. ficam como
estão.

### 4. Mudanças nos Termos e na Política

- **Termos v4:** §1.1 (nome empresarial, MEI, CNPJ, nome comercial,
  endereço, titular); §1.1.1 (a operação é conduzida pelo empresário
  individual; se mudar, os Termos mudam antes ou junto); §16.1 diz
  "Operador" e **não** afirma emissão de nota; assinatura; CPF removido;
  numeração das seções preservada.
- **Política v5:** bloco do controlador; parágrafo equivalente ao 1.1.1;
  14.1 ("ao Operador"); **20.3** — o art. 15 do Marco Civil deixou de ser
  "não se aplica" e passou a "a SAN & CO. avalia a aplicação"; assinatura;
  CPF removido. Nenhum outro tratamento de dado foi alterado.
- As versões anteriores (Termos v3, Política v4) foram arquivadas
  intactas antes da troca, conferidas com `cmp`.
- Responsabilidade: nada foi escrito atribuindo ao MEI responsabilidade
  pelas transações de terceiros; o vendedor segue respondendo pela sua
  venda e pela nota do seu produto (Termos §16.2).

### 5. Status da integração Asaas

**Não alterada e não reconferida.** Nenhuma credencial, chave,
identificador de contratante, webhook, conta de recebimento, split ou
configuração foi tocada, e nenhuma chamada foi feita à Asaas. A última
medição do cadastro (17/09/2026) é `FISICA`/CPF, e `commercialInfo`
`JURIDICA`/CNPJ. Mudar o nome no código não atualiza a Asaas.

### 6. Dependências manuais no painel do provedor (do titular)

1. Pelo **canal oficial da Asaas** (painel, na área de dados da conta,
   ou o suporte), pedir a atualização do cadastro de pessoa física para
   o MEI, conferindo nome empresarial, CNPJ e dados comerciais. A
   validação cadastral/KYC é da Asaas e não deve ser contornada.
2. Depois disso, conferir o que o pagador passa a ver como recebedor e
   avisar a sessão técnica para **reconferir** `/v3/myAccount` (medição,
   não suposição) e, se for o caso, revisar o §9 dos Termos.
3. Atualizar o cadastro **não** liga split nem subconta; isso é V2.

### 7. Testes executados e resultados

Ver a seção "Verificação" abaixo.

### 8. Pendências legais e cadastrais

Detalhadas em `docs/pendencias.md`, "Reabertura por formalização":
cadastro Asaas × MEI; CNAE 8230001 e emissão fiscal (contador);
confirmação do endereço (Rua 28 de Agosto, 2502); Marco Civil art. 15;
redação do §9 dos Termos frente ao cadastro da Asaas; CPF real ainda como
fixture em código/testes/exemplos; validação regulatória de dinheiro de
terceiro (V2); e ausência de aceite anterior a comunicar. Telefone,
inscrição estadual e e-mail comercial **não** foram inventados.

## Verificação

Executado em 11/11/2026, na branch, antes do commit:

- `npm ci` e `npm run check`: análise de sintaxe de todo JS e **82
  suítes — tudo passou**. Isso inclui `tests/o-que-os-documentos-afirmam.js`
  (ponteiros e contagem de suítes nos documentos vivos) e
  `tests/rodape-nao-cita-identidade-antiga.js` (23 checagens: CNPJ com
  dígitos válidos, Termos = Política = três rodapés, nenhum CPF em HTML
  público, com controles positivos). A primeira rodada de `npm run check`
  falhou em dezenas de arquivos só porque `node_modules` não estava instalado no
  ambiente (`@supabase/supabase-js` ausente); não era regressão, e passou
  após `npm ci`.
- `npm run acessibilidade` (axe, WCAG 2.2 AA, Chromium): **0 violações**
  em todas as telas, inclusive Termos e Política, nos estados do checkout
  e na navegação por teclado.
- Aninhamento de tags conferido nos cinco HTML editados; nenhum CPF
  restante em `public/`.
- **Não executado:** `npm run desempenho` (as mudanças são só texto de
  rodapé e de documento legal) e qualquer chamada à Asaas ou ao banco.
