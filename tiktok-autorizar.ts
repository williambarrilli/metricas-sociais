// Autoriza o app do TikTok uma única vez (Login Kit para Desktop, com PKCE) e grava os tokens em .env.tiktok.
// Depois disso, `npm run metricas` renova o token sozinho.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ARQUIVO_ENV_TIKTOK, TIKTOK_TOKEN_URL, gravarEnv, lerEnv, valoresTokenTikTok } from './metricas.js';

export const PORTA = 3455;
// Precisa ser idêntica à "Desktop Redirect URI" cadastrada no Login Kit do app.
export const REDIRECT_URI = `http://localhost:${PORTA}/callback/`;
export const ESCOPOS = ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list'];
const TEMPO_LIMITE_MS = 5 * 60 * 1000;
// Client key (não é segredo) do Sandbox "metricas" do app "tiktok" no TikTok for Developers.
const CLIENT_KEY_SANDBOX = 'sbawlybv9z9lgpa0wc';

// O Login Kit para Desktop do TikTok pede o SHA-256 do verificador em hexadecimal.
export function criarPkce() {
  const verificador = crypto.randomBytes(48).toString('base64url');
  const desafio = crypto.createHash('sha256').update(verificador).digest('hex');
  return { verificador, desafio };
}

export function urlAutorizacao(clientKey: string, desafio: string, estado: string) {
  const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
  url.search = new URLSearchParams({
    client_key: clientKey, response_type: 'code', scope: ESCOPOS.join(','), redirect_uri: REDIRECT_URI,
    state: estado, code_challenge: desafio, code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

async function perguntar(texto: string) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(texto)).trim(); } finally { rl.close(); }
}

function abrirNavegador(url: string) {
  const comando = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try { spawn(comando, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* o link já foi impresso */ }
}

function esperarCodigo(estado: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const pagina = (titulo: string, texto: string) => `<!doctype html><meta charset="utf-8"><title>${titulo}</title>`
      + `<body style="font-family:sans-serif;text-align:center;padding:4rem"><h1>${titulo}</h1><p>${texto}</p></body>`;
    const servidor = http.createServer((req, res) => {
      const url = new URL(req.url || '/', REDIRECT_URI);
      if (url.pathname !== new URL(REDIRECT_URI).pathname) { res.writeHead(404).end(); return; }
      const erro = url.searchParams.get('error');
      const codigo = url.searchParams.get('code');
      const ok = !erro && codigo && url.searchParams.get('state') === estado;
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ok ? pagina('Pronto!', 'TikTok autorizado. Pode fechar esta aba e voltar ao terminal.')
        : pagina('Não deu certo', 'Volte ao terminal para ver o motivo.'));
      clearTimeout(limite);
      servidor.close();
      if (ok) resolve(codigo!);
      else reject(new Error(erro ? `O TikTok recusou a autorização: ${url.searchParams.get('error_description') || erro}` : 'Resposta sem código ou com state diferente.'));
    });
    const limite = setTimeout(() => { servidor.close(); reject(new Error('Tempo esgotado esperando a autorização (5 min).')); }, TEMPO_LIMITE_MS);
    servidor.on('error', (erro) => { clearTimeout(limite); reject(erro); });
    servidor.listen(PORTA, 'localhost');
  });
}

async function principal() {
  const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const arquivo = path.join(raiz, ARQUIVO_ENV_TIKTOK);
  lerEnv(raiz);
  let clientKey = process.env.TIKTOK_CLIENT_KEY;
  let clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey) {
    clientKey = CLIENT_KEY_SANDBOX;
    gravarEnv(arquivo, { TIKTOK_CLIENT_KEY: clientKey });
  }
  if (!clientSecret) {
    clientSecret = await perguntar('Cole o Client secret (TikTok for Developers > app tiktok > Sandbox metricas > Credentials, ícone de olho): ');
    if (!clientSecret) throw new Error('Client secret vazio.');
    gravarEnv(arquivo, { TIKTOK_CLIENT_SECRET: clientSecret });
  }
  const { verificador, desafio } = criarPkce();
  const estado = crypto.randomBytes(16).toString('hex');
  const url = urlAutorizacao(clientKey, desafio, estado);
  const aguardando = esperarCodigo(estado);
  console.log('Abra este link no Chrome logado na conta do canal e clique em Autorizar:\n');
  console.log(`${url}\n`);
  abrirNavegador(url);
  const codigo = await aguardando;
  const resposta = await fetch(TIKTOK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: clientKey, client_secret: clientSecret, code: codigo, grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI, code_verifier: verificador,
    }).toString(),
  });
  const bruto = await resposta.text();
  let json: any = {};
  try { json = JSON.parse(bruto); } catch { /* mostra o erro abaixo */ }
  const valores = valoresTokenTikTok(json);
  gravarEnv(arquivo, valores);
  console.log(`Tokens do TikTok salvos em ${ARQUIVO_ENV_TIKTOK} (escopos: ${json.scope || 'não informado'}).`);
  console.log('Agora rode: npm run metricas');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().catch((erro) => {
    const segredo = process.env.TIKTOK_CLIENT_SECRET;
    let texto = erro instanceof Error ? erro.message : String(erro);
    if (segredo) texto = texto.replaceAll(segredo, '[oculto]');
    console.error(`Erro: ${texto}`);
    process.exitCode = 1;
  });
}
