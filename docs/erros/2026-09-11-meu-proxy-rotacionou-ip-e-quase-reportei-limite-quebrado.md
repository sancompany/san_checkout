# Meu proxy rotacionou IP e eu quase reportei o rate limit como quebrado

**Sintoma.** Doze `POST` seguidos em `/api/checkout/pix`, com o limite
configurado em 10/min, e nenhum 429. Conclusão imediata e errada: **o
limitador que protege as rotas de dinheiro está inerte em produção.**

**Causa raiz.** As requisições não saíram todas do mesmo IP. O proxy de
saída do ambiente de onde eu testava alterna entre três endereços
(`160.79.106.129`, `.135`, `.136`), e o `express-rate-limit` conta por
IP. Cada IP abriu o próprio balde e nenhum chegou a 10.

O que desfez o engano foi ler os cabeçalhos em vez do código de status:
`RateLimit-Remaining` caía de 9 para 8 e **parava**, alternando — a
assinatura de contadores paralelos, não de contador quebrado.

**Correção.** Nenhuma no produto: o limitador funciona. O achado real é
outro, e ficou registrado no `CONSTRAINTS.md` §2.7 — **limite por IP não
é guarda de força bruta em credencial.** Qualquer um com um punhado de
endereços multiplica o teto pelo número deles, que foi o que eu fiz sem
querer.

**Guarda.** O §2.7 declara o limite pelo que ele realmente entrega, e
não pelo número escrito na configuração.

**Como evitar na origem.** Teste de limite de taxa que não fixa a
origem não testa limite de taxa. E, de modo mais geral: antes de
declarar quebrado o que está do lado de lá, conferir o que o lado de cá
está de fato mandando. É o mesmo erro de método da política do
Cloudflare Access que "passou" porque o navegador já tinha o cookie de
sessão, e do estado de projeto afirmado a partir de uma cópia velha:
**o ambiente do teste faz parte do teste.**

**Ecossistema:** sim — vale para qualquer verificação feita de dentro de
CI, container, VPN ou proxy corporativo. O endereço de origem, o cookie
que já está lá e o relógio do ambiente são variáveis do experimento, não
constantes.
