# Relatório de Segurança — San Checkout v2

**Data:** 09/09/2026
**Escopo:** `checkout.sancocore.com.br` (Cloudflare Pages) + `san-checkout.onrender.com` (backend) + Supabase, após o commit `a3e19a6` (último `git push` confirmado).

**Metodologia, com honestidade sobre os limites:** não tenho uma ferramenta de pentest de verdade (tipo Burp Suite ou OWASP ZAP) nem acesso a scanner de infraestrutura. O que fiz foi (1) revisão de código de todos os pontos sensíveis — autenticação, CORS, rate limit, validação, tratamento de erro —, e (2) teste ao vivo em produção usando o navegador do seu computador: inspecionei headers reais de resposta, tentei acessar endpoints protegidos sem credencial, conferi CSP e políticas de CORS de fato aplicadas. Isso é bem mais do que uma leitura só do código, mas não substitui um pentest profissional.

---

## 1. Confirmação do deploy

O `git push a3e19a6` está no ar e correto. Reconferi agora:

- `/api/saude` responde `supabaseRespondendo: true` — migração `cpf → documento` confirmada em produção.
- O ajuste de CSP que eu tinha deixado pendente (liberar `static.cloudflareinsights.com` pro script de analytics da própria Cloudflare) está no ar e funcionando: refiz o teste do zero agora e o script carrega sem erro de CSP no console. O bloqueio que eu via antes era o deploy anterior ainda propagando na borda da Cloudflare — não era um problema de configuração.
- Header `Content-Security-Policy` do front conferido byte a byte: só uma política ativa (não há duas se sobrepondo, o que às vezes acontece quando um provedor injeta uma CSP própria por cima da sua — não é o caso aqui).

Nada pendente do lado técnico para este push.

---

## 2. Postura de segurança atual vs. o padrão do mercado

Pontos que já estão implementados e, comparados com o que a maioria dos projetos do mesmo porte tem, colocam o San Checkout acima da média:

**Nunca toca dado de cartão.** O número do cartão é digitado dentro da pop-up hospedada da própria Asaas — o servidor de vocês nunca recebe, processa ou armazena esse dado. Isso tira o projeto inteiro do escopo de PCI-DSS, que é de longe a maior fonte de risco e de custo de conformidade em qualquer checkout. É a decisão de arquitetura mais importante que existe aqui, e já está certa.

**Banco de dados com RLS fechado por padrão.** As tabelas `contratantes`, `cobrancas` e `assinaturas` têm Row Level Security habilitado sem nenhuma policy — ou seja, mesmo que a chave anônima do Supabase vazasse de algum jeito, ninguém consegue ler ou escrever nada por ela. Só a `service_role key`, que fica só no backend, tem acesso. Essa é a configuração recomendada pelo próprio Supabase e a maioria dos projetos pequenos não faz isso corretamente (ou esquece de habilitar RLS, ou habilita com policy frouxa demais).

**Autenticação com fail-closed e comparação em tempo constante.** As rotas de admin, webhook e estorno recusam com 401 genérico (sem detalhe interno, sem stack trace) quando falta credencial, e se a variável de ambiente da senha/token não estiver configurada, a rota recusa tudo (503) em vez de "abrir" por acidente. A comparação da credencial é feita em tempo constante (`compararSeguro`), o que evita um ataque de timing — um cuidado que a maioria dos códigos escritos rapidamente pula (comparação direta com `===` vaza, por diferença de tempo de resposta, quantos caracteres da senha estão certos).

**CORS restrito ao domínio certo**, não `*`. **Rate limiting por rota**, corrigido depois de um bug real que juntava três rotas num balde só. **Validação de CPF/CNPJ, e-mail, telefone, CEP e valor no backend**, não só no front — o que importa de verdade, já que validação só no navegador é sempre contornável.

**Headers HTTP completos nos dois domínios** — CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy. A maioria dos sites pequenos e médios não configura nenhum desses (o padrão de fábrica de qualquer host geralmente não inclui CSP), e CSP em particular é o header que mais protege contra XSS — que é a vulnerabilidade mais comum na web em geral.

**Superfície de dependências pequena.** Seis pacotes diretos (`@supabase/supabase-js`, `cors`, `dotenv`, `express`, `express-rate-limit`, `helmet`), todos bem estabelecidos e mantidos ativamente. Cada dependência a mais é um risco de supply-chain a mais (um pacote comprometido rio abaixo); ter poucas e conhecidas reduz bastante esse risco em comparação com projetos node típicos, que às vezes têm centenas de dependências transitivas.

**Incidente de vazamento de segredo já tratado corretamente.** Quando a `SUPABASE_SERVICE_KEY` e a `CHECKOUT_ADMIN_PASS` foram expostas acidentalmente no chat, ambas foram rotacionadas — a resposta certa a esse tipo de incidente é trocar a credencial, não só "confiar que ninguém viu".

### Onde fica abaixo do ideal (não bloqueia nada, mas vale registrar)

- Não existe hoje monitoramento de erro em produção (tipo Sentry) — o único registro é `console.error`. Isso não é uma vulnerabilidade em si, mas significa que uma tentativa de ataque ou um bug real em produção só aparece se alguém for procurar manualmente.
- O retry do webhook é em memória (`setTimeout`); se o processo do Render reiniciar no meio das 3 tentativas, aquela notificação pendente se perde. É uma questão de confiabilidade de entrega, não de segurança, mas pode custar dinheiro/confiança se acontecer num momento ruim.
- `npm audit` / Dependabot ainda não rodou de forma recorrente.
- Não existe um WAF/proteção extra na frente do backend do Render (o Cloudflare hoje só protege o front estático). Não é incomum pra esse porte de projeto, mas é a próxima camada natural se o tráfego crescer.
- Ainda há 3 arquivos órfãos no repositório (`driveService.js`, `emailService.js`, `googleDrive.js`) — não são chamados por nada, mas reduzir a superfície de código morto é sempre saudável.

---

## 3. Sua pergunta direta: existe algo comum ou raro de acontecer, por onde conseguiriam invadir?

Respondendo com base na arquitetura real que revisei — não em especulação genérica.

### Vetores comuns (os que de fato acontecem com mais frequência em projetos deste porte)

1. **Phishing ou reuso de senha vazada contra as contas de admin** (Render, Cloudflare, Supabase, GitHub, Asaas, ou o próprio `admin.html`). Isso é, disparado, a forma mais comum de invasão real em projetos pequenos e médios — não é um hacker "quebrando" o código, é alguém conseguindo a senha por fora. A defesa é 2FA em todas essas contas, que ainda não está confirmado como ativo (ver seção 4).
2. **Vulnerabilidade conhecida em alguma dependência** que ainda não foi corrigida por falta de atualização. Com só 6 pacotes diretos o risco já é baixo, mas sem `npm audit` recorrente, uma CVE nova pode passar despercebida.
3. **Tentativa de forjar um webhook** (alguém mandando um POST fingindo ser a Asaas dizendo "pagamento confirmado" pra liberar produto sem pagamento real). Esse é o ataque mais óbvio que alguém tentaria contra um checkout — e já está coberto: o endpoint exige o token da Asaas, recusa sem ele (fail-closed) e a comparação é em tempo constante.
4. **Bots e tráfego automatizado batendo nos endpoints públicos** (criação de cobrança, consulta de pedido) tentando abusar ou sobrecarregar. Já mitigado pelo rate limiting por rota.

### Vetores raros (baixa probabilidade, mas realistas em teoria)

1. **Vulnerabilidade de infraestrutura no próprio Render, Cloudflare, Supabase ou Asaas** — fora do controle do código de vocês; a única defesa possível é manter as contas seguras (2FA) e os planos/serviços atualizados.
2. **Ataque de supply-chain via um pacote npm comprometido** (um mantenedor tendo a conta invadida e publicando uma versão maliciosa de um pacote legítimo — já aconteceu com pacotes famosos no ecossistema node). Real, mas raro, e mitigado por ter poucas dependências e rodar auditoria de vez em quando.
3. **Sequestro de DNS ou invasão da conta do registrador do domínio** `sancocore.com.br` — permitiria redirecionar o checkout inteiro para outro lugar. Defesa: 2FA + travamento de transferência (registrar lock), se o registrador oferecer.
4. **Injeção de SQL** — já conferida no código (o cliente do Supabase usa consultas parametrizadas, não concatenação de string) e tem uma segunda camada de proteção mesmo que existisse um bug: o RLS fechado por padrão limitaria o dano.

**Resumo direto:** dado que cartão nunca toca o servidor, o banco está fechado por padrão, a autenticação falha fechada em todo lugar sensível, e as dependências são poucas e conhecidas, o risco real que sobra está concentrado quase todo em **segurança de conta** (2FA) e **disciplina operacional** (rodar `npm audit`, não colar segredo em lugar nenhum) — não em falha de código. É o lugar saudável pro risco estar.

---

## 4. Passos manuais, em ordem de prioridade

1. **Ativar 2FA em Render, Cloudflare, Supabase, GitHub e Asaas**, se ainda não estiver. Não dá pra verificar ou ativar remotamente — é o item de maior alavancagem que falta, porque é a defesa direta contra o vetor de invasão mais comum na prática (phishing/senha vazada), listado na seção 3.
2. **Rodar `npm audit`** na pasta do projeto (ou ativar o Dependabot no GitHub, que funciona em repositório privado também) — leva menos de 2 minutos e não custa nada.
3. **Conferir se o registrador do domínio `sancocore.com.br` tem 2FA e travamento de transferência ativos.**
4. *(Opcional, não bloqueia)* Configurar um monitoramento de erro básico (Sentry tem plano gratuito) — hoje um erro em produção só aparece se alguém for olhar o log manualmente.
5. *(Opcional, organização)* Apagar os 3 arquivos órfãos (`driveService.js`, `emailService.js`, `googleDrive.js`) listados no `status-atual.md` — comando já preparado lá, é só rodar no PowerShell.

Nenhum desses 5 itens exige mudança de código — são todos configuração manual nas contas ou comandos de manutenção.
