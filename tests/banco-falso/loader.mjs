/**
 * tests/banco-falso/loader.mjs — troca `src/config/supabase.js` por um
 * cliente de MENTIRA, guardado num arquivo JSON, num processo filho:
 *
 *   node --import ./tests/banco-falso/loader.mjs script.mjs
 *
 * Existe para provar, em processo separado, que o que uma passada
 * gravou a outra ENCONTRA — durabilidade de verdade, não de memória.
 * O arquivo vem de `BANCO_FALSO_ARQUIVO`.
 */
import { register } from 'node:module';

register('./resolver.mjs', import.meta.url);
