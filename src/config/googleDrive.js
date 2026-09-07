/**
 * SAN CHECKOUT v2 — src/config/googleDrive.js
 * Autenticação via conta de serviço (service account) — nada de OAuth
 * interativo, é servidor-pra-servidor.
 *
 * ⚠️ NUNCA TESTADO. Pra funcionar de verdade:
 *   1. Criar uma conta de serviço no Google Cloud Console, com a
 *      Drive API habilitada no projeto.
 *   2. Gerar uma chave JSON dela — `client_email` vira
 *      GOOGLE_SERVICE_ACCOUNT_EMAIL, `private_key` vira
 *      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (mantendo as quebras de
 *      linha — no .env, isso normalmente aparece como "\n" literal,
 *      por isso o replace abaixo).
 *   3. Compartilhar a pasta raiz do Drive (GOOGLE_DRIVE_ROOT_FOLDER_ID)
 *      com o e-mail dessa conta de serviço — sem isso, ela não enxerga
 *      a pasta e toda chamada falha.
 */

import { google } from 'googleapis';

let clienteCache = null;

export function getClienteDrive() {
  if (clienteCache) return clienteCache;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const chavePrivadaBruta = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

  if (!email || !chavePrivadaBruta) {
    throw new Error('Credenciais do Google Drive não configuradas no .env.');
  }

  const chavePrivada = chavePrivadaBruta.replace(/\\n/g, '\n');

  const auth = new google.auth.JWT({
    email,
    key: chavePrivada,
    scopes: ['https://www.googleapis.com/auth/drive']
  });

  clienteCache = google.drive({ version: 'v3', auth });
  return clienteCache;
}
