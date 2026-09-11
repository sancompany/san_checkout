# HTML novo servido com JS velho (cache do Pages)

**Sintoma.** Depois de um deploy, o painel administrativo morria no login
com `Cannot set properties of null (setting 'hidden')`. O mesmo código
rodava perfeitamente em ambiente local, e tanto o HTML quanto o JS
publicados na origem estavam corretos e consistentes entre si.

**Causa raiz.** O Cloudflare Pages servia, por padrão,
`Cache-Control: public, max-age=0, must-revalidate` para o HTML e
`public, max-age=14400, must-revalidate` para `.js` e `.css`. HTML sempre
fresco, script e estilo parados por até **4 horas**. O navegador
executava o HTML novo com o JS da versão anterior, que procurava
elementos que aquele HTML não tinha mais.

O mesmo mecanismo deixava o CSS corrigido invisível: a correção estava no
ar e o navegador continuava com a cópia velha.

**Correção.** `Cache-Control: public, max-age=0, must-revalidate` no
bloco `/*` de `public/_headers`. Custa um 304 por arquivo.

**Guarda.** O comentário fica **fora** do bloco `/*`, não indentado —
comentário indentado pode não ser reconhecido pelo parser do Pages, e se
o bloco for descartado a CSP cai junto.

**Como evitar na origem.** Deploy de front sem cache-busting precisa de
revalidação forçada. Diagnóstico: quando o código local funciona e o
publicado não, comparar **os headers**, não só o conteúdo dos arquivos —
`fetch(url).then(r => r.headers.get('cache-control'))` resolve em
segundos o que dedução não resolve.

**Ecossistema:** sim — qualquer hospedagem estática serve HTML e assets com políticas de cache diferentes por padrão. Sem cache-busting, o navegador roda HTML novo com script velho, e o código local funciona enquanto o publicado não.
