# O `noindex` existia no arquivo e não existia na web

**Sintoma.** Nenhum visível — e é essa a gravidade. `public/_headers`
declarava `X-Robots-Tag: noindex` para `/admin.html` e `/status.html`, o
arquivo estava certo, o deploy estava certo, e a página de status do
comprador continuava indexável por qualquer buscador.

**Causa raiz.** O Cloudflare Pages não serve `/status.html`: ele responde
**308** de `/status.html` para `/status`. A regra do `_headers` casava o
caminho do ARQUIVO, então o header saía grudado no redirecionamento. O
buscador segue o 308, recebe a página final — e a página final vinha sem
header nenhum.

Medido em produção, não deduzido: `curl -D- /status.html` devolvia
`x-robots-tag` num 308, e `curl -D- /status` devolvia 200 com o header
ausente.

**Correção.** As seis formas listadas no `public/_headers`:
`/admin.html`, `/admin`, `/admin/`, `/status.html`, `/status`,
`/status/`.

**Guarda.** O bloco de comentário acima das regras explica por que o
caminho do arquivo não serve, e cita a medição com data. Sem isso, a
próxima limpeza remove as formas "duplicadas" e devolve o buraco.

**Como evitar na origem.** Regra de borda casa o caminho que o servidor
**entrega**, não o nome do arquivo no repositório. E a verificação é
sempre `curl` no caminho público, nunca a leitura do arquivo de
configuração: o arquivo diz a intenção, e é justamente a distância entre
intenção e efeito que este tipo de erro ocupa.

**Ecossistema:** sim — todo host estático moderno (Pages, Netlify,
Vercel) normaliza `.html` para caminho limpo, e todos configuram header
por padrão de caminho. A mesma regra escrita do jeito óbvio falha calada
nos três.
