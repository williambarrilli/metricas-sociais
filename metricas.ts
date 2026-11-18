// Coleta somente métricas públicas/autorizadas; tokens ficam exclusivamente no .env.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Env = Record<string, string | undefined>;
type Periodo = { dias: number; fuso: string; desde: string; ate: string };
type FetchImpl = (url: string, opcoes?: any) => Promise<any>;
type OpcoesRequisicao = { fetchImpl?: FetchImpl; token?: string; method?: string; body?: any; form?: Record<string, string> };
type SalvarEnv = (valores: Record<string, string>) => void;
type ArgsColeta = { env: Env; periodo: Periodo; fetchImpl: FetchImpl; salvarEnv?: SalvarEnv; agora?: Date };
type Coleta = (args: ArgsColeta) => Promise<any>;
type Plataforma = { status: 'ok' | 'erro'; erro?: string; conta: any; publicacoes: any[]; avisos: string[] };
type Relatorio = { geradoEm: string; periodo: Periodo; parcial: boolean; plataformas: Record<string, Plataforma> };
type OpcoesColeta = { env?: Env; dias?: number; agora?: Date; fetchImpl?: FetchImpl; coletas?: Record<string, Coleta>; salvarEnv?: SalvarEnv };
type Argumentos = { dias: number; saida?: string; ajuda?: boolean };

// .env guarda as credenciais manuais; .env.tiktok guarda os tokens do TikTok, que o próprio script renova.
export const ARQUIVOS_ENV = ['.env', '.env.tiktok'];
export const ARQUIVO_ENV_TIKTOK = '.env.tiktok';

export function lerEnv(raiz: string) {
  for (const nome of ARQUIVOS_ENV) {
    const arquivo = path.join(raiz, nome);
    if (!fs.existsSync(arquivo)) continue;
    for (const linha of fs.readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
      const dado = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (dado && !process.env[dado[1]]) process.env[dado[1]] = dado[2].replace(/^["']|["']$/g, '');
    }
  }
}

// Atualiza (ou acrescenta) chaves num arquivo .env sem mexer nas outras linhas.
export function gravarEnv(arquivo: string, valores: Record<string, string>) {
  const linhas = fs.existsSync(arquivo) ? fs.readFileSync(arquivo, 'utf8').split(/\r?\n/) : [];
  const pendentes = new Map(Object.entries(valores));
  const novas = linhas.map((linha) => {
    const chave = linha.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1];
    if (!chave || !pendentes.has(chave)) return linha;
    const valor = pendentes.get(chave)!;
    pendentes.delete(chave);
    return `${chave}=${valor}`;
  });
  while (novas.length && novas.at(-1) === '') novas.pop();
  for (const [chave, valor] of pendentes) novas.push(`${chave}=${valor}`);
  fs.writeFileSync(arquivo, `${novas.join('\n')}\n`, { mode: 0o600 });
}

const TZ = 'America/Sao_Paulo';
const META_BASE = 'https://graph.facebook.com';
const META_INSTAGRAM_BASE = 'https://graph.instagram.com';
const TIKTOK_BASE = 'https://open.tiktokapis.com/v2';
const YOUTUBE_BASE = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_ANALYTICS_BASE = 'https://youtubeanalytics.googleapis.com/v2';

function dataNoFuso(data: Date, timeZone = TZ) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(data).reduce<Record<string, string>>((acc, parte) => ({ ...acc, [parte.type]: parte.value }), {});
  return `${partes.year}-${partes.month}-${partes.day}`;
}

function adicionarDias(dataIso: string, dias: number) {
  const data = new Date(`${dataIso}T00:00:00Z`);
  data.setUTCDate(data.getUTCDate() + dias);
  return data.toISOString().slice(0, 10);
}

export function criarPeriodo(dias = 30, agora = new Date()) {
  if (!Number.isInteger(dias) || dias < 1) throw new Error('--dias deve ser um número inteiro maior que zero.');
  const ate = dataNoFuso(agora);
  return { dias, fuso: TZ, desde: adicionarDias(ate, 1 - dias), ate };
}

function dataEstaNoPeriodo(data: string | number | Date | undefined, periodo: Periodo) {
  if (!data) return false;
  const iso = new Date(data).toISOString().slice(0, 10);
  return iso >= periodo.desde && iso <= periodo.ate;
}

function numero(valor: unknown) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

function textoErro(erro: unknown, segredos: string[] = []) {
  let texto = erro instanceof Error ? erro.message : String(erro);
  for (const segredo of segredos.filter(Boolean)) texto = texto.replaceAll(segredo, '[oculto]');
  return texto.slice(0, 500);
}

function exigir(env: Env, campos: string[]) {
  const faltando = campos.filter((campo) => !env[campo]);
  if (faltando.length) throw new Error(`Configure no .env: ${faltando.join(', ')}.`);
}

function urlApi(base: string, caminho: string, parametros: Record<string, unknown> = {}) {
  const url = new URL(caminho.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`);
  for (const [chave, valor] of Object.entries(parametros)) {
    if (valor !== undefined && valor !== null && valor !== '') url.searchParams.set(chave, String(valor));
  }
  return url.toString();
}

async function requisitarJson(url: string, { fetchImpl = fetch as unknown as FetchImpl, token, method = 'GET', body, form }: OpcoesRequisicao = {}) {
  const resposta = await fetchImpl(url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(!form && body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    ...(!form && body ? { body: JSON.stringify(body) } : {}),
  });
  const bruto = await resposta.text();
  let json;
  try { json = bruto ? JSON.parse(bruto) : {}; } catch { json = {}; }
  if (!resposta.ok || json.error?.code && json.error.code !== 'ok' && json.error.code !== 0) {
    const detalhe = json.error?.message || json.error?.error_detail || json.message || bruto || 'resposta sem detalhe';
    throw new Error(`API respondeu ${resposta.status}: ${detalhe}`);
  }
  return json;
}

async function tokenYouTube(env: Env, fetchImpl: FetchImpl) {
  if (!env.YOUTUBE_REFRESH_TOKEN) {
    exigir(env, ['YOUTUBE_ACCESS_TOKEN']);
    return env.YOUTUBE_ACCESS_TOKEN;
  }
  exigir(env, ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET']);
  const resposta = await requisitarJson('https://oauth2.googleapis.com/token', {
    fetchImpl, method: 'POST', form: {
      client_id: env.YOUTUBE_CLIENT_ID!, client_secret: env.YOUTUBE_CLIENT_SECRET!,
      refresh_token: env.YOUTUBE_REFRESH_TOKEN, grant_type: 'refresh_token',
    },
  });
  if (!resposta.access_token) throw new Error('A renovação do token do YouTube não retornou access_token.');
  return resposta.access_token;
}

export async function paginarGet(url: string, opcoes: OpcoesRequisicao = {}) {
  const itens = [];
  let proxima = url;
  while (proxima) {
    const json = await requisitarJson(proxima, opcoes);
    itens.push(...(json.data || []));
    proxima = json.paging?.next || null;
  }
  return itens;
}

function valorInsight(insights: any, nome: string) {
  const insight = (insights?.data || []).find((item: any) => item.name === nome);
  const valores = insight?.values || [];
  return numero(insight?.total_value?.value ?? valores.at(-1)?.value ?? insight?.value);
}

function totalInsight(insights: any, nome: string) {
  const insight = (insights?.data || []).find((item: any) => item.name === nome);
  if (!insight) return null;
  const total = numero(insight.total_value?.value ?? insight.value);
  if (total !== null) return total;
  const valores = insight.values || [];
  const numeros = valores.map((item: any) => numero(item.value)).filter((valor: number | null): valor is number => valor !== null);
  return numeros.length ? numeros.reduce((soma: number, valor: number) => soma + valor, 0) : null;
}

function totalInsightChave(insights: any, nome: string, chave: string) {
  const insight = (insights?.data || []).find((item: any) => item.name === nome);
  if (!insight) return null;
  const valores = [insight.total_value?.value, insight.value, ...(insight.values || []).map((item: any) => item.value)];
  const numeros = valores.map((valor) => numero(valor?.[chave])).filter((valor: number | null): valor is number => valor !== null);
  return numeros.length ? numeros.reduce((soma: number, valor: number) => soma + valor, 0) : null;
}

function totalInsightDetalhado(insights: any, nome: string, categoria: string) {
  const insight = (insights?.data || []).find((item: any) => item.name === nome);
  const resultados = [insight?.total_value, ...(insight?.values || [])]
    .flatMap((valor: any) => valor?.breakdowns || [])
    .flatMap((breakdown: any) => breakdown.results || []);
  const numeros = resultados
    .filter((resultado: any) => (resultado.dimension_values || []).some((valor: string) => valor.toLowerCase() === categoria.toLowerCase()))
    .map((resultado: any) => numero(resultado.value))
    .filter((valor: number | null): valor is number => valor !== null);
  return numeros.length ? numeros.reduce((soma: number, valor: number) => soma + valor, 0) : null;
}

function segundosDeMilissegundos(valor: unknown) {
  const milissegundos = numero(valor);
  return milissegundos === null ? null : milissegundos / 1000;
}

function baseInstagram(env: Env) {
  return env.META_IG_LOGIN === 'instagram' ? META_INSTAGRAM_BASE : META_BASE;
}

async function metricasInstagram(mid: string, versao: string, token: string, fetchImpl: FetchImpl, base: string, reel: boolean) {
  try {
    const dados = await requisitarJson(urlApi(base, `/${versao}/${mid}/insights`, {
      metric: 'views,reach,shares,saved,total_interactions',
    }), { token, fetchImpl });
    let dadosReel: any = null;
    let aviso: string | undefined;
    if (reel) {
      try {
        dadosReel = await requisitarJson(urlApi(base, `/${versao}/${mid}/insights`, {
          metric: 'ig_reels_avg_watch_time,ig_reels_video_view_total_time,reels_skip_rate',
        }), { token, fetchImpl });
      } catch (erro) {
        aviso = textoErro(erro, [token]);
      }
    }
    return {
      visualizacoes: valorInsight(dados, 'views'), alcance: valorInsight(dados, 'reach'),
      compartilhamentos: valorInsight(dados, 'shares'), salvamentos: valorInsight(dados, 'saved'),
      interacoes: valorInsight(dados, 'total_interactions'),
      tempoMedioReproducaoSegundos: segundosDeMilissegundos(valorInsight(dadosReel, 'ig_reels_avg_watch_time')),
      tempoTotalReproducaoSegundos: segundosDeMilissegundos(valorInsight(dadosReel, 'ig_reels_video_view_total_time')),
      taxaPuloPrimeiros3Segundos: valorInsight(dadosReel, 'reels_skip_rate'), aviso,
    };
  } catch (erro) {
    return {
      visualizacoes: null, alcance: null, compartilhamentos: null, salvamentos: null, interacoes: null,
      tempoMedioReproducaoSegundos: null, tempoTotalReproducaoSegundos: null, taxaPuloPrimeiros3Segundos: null,
      aviso: textoErro(erro, [token]),
    };
  }
}

async function metricasContaInstagram(id: string, versao: string, token: string, fetchImpl: FetchImpl, base: string, periodo: Periodo) {
  const avisos: string[] = [];
  const consultar = async (metric: string, parametros: Record<string, string> = {}) => {
    try {
      return await requisitarJson(urlApi(base, `/${versao}/${id}/insights`, {
        metric, period: 'day', since: periodo.desde, until: periodo.ate, ...parametros,
      }), { token, fetchImpl });
    } catch (erro) {
      avisos.push(`${metric}: ${textoErro(erro, [token])}`);
      return { data: [] };
    }
  };
  const perfil = await consultar('profile_views');
  const follows = await consultar('follows_and_unfollows');
  const views = await consultar('views', { breakdown: 'follow_type' });
  return {
    metricasPeriodo: {
      visitasPerfil: totalInsight(perfil, 'profile_views'),
      seguidoresGanhos: totalInsightChave(follows, 'follows_and_unfollows', 'follows'),
      seguidoresPerdidos: totalInsightChave(follows, 'follows_and_unfollows', 'unfollows'),
      visualizacoesSeguidores: totalInsightDetalhado(views, 'views', 'FOLLOWER'),
      visualizacoesNaoSeguidores: totalInsightDetalhado(views, 'views', 'NON_FOLLOWER'),
    },
    avisos,
  };
}

async function coletarInstagram({ env, periodo, fetchImpl }: ArgsColeta) {
  exigir(env, ['META_IG_USER_ID', 'META_IG_ACCESS_TOKEN']);
  const versao = env.META_GRAPH_VERSION || 'v27.0';
  const token = env.META_IG_ACCESS_TOKEN!;
  const base = baseInstagram(env);
  const conta = await requisitarJson(urlApi(base, `/${versao}/${env.META_IG_USER_ID}`, {
    fields: 'id,username,name,followers_count,media_count',
  }), { token, fetchImpl });
  const midias = await paginarGet(urlApi(base, `/${versao}/${env.META_IG_USER_ID}/media`, {
    fields: 'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count', limit: 100,
  }), { token, fetchImpl });
  const recentes = midias.filter((midia) => dataEstaNoPeriodo(midia.timestamp, periodo));
  const publicacoes = await Promise.all(recentes.map(async (midia) => {
    const insights = await metricasInstagram(midia.id, versao, token, fetchImpl, base, midia.media_product_type === 'REELS');
    return {
      id: midia.id, tipo: midia.media_product_type || midia.media_type, publicadoEm: midia.timestamp,
      url: midia.permalink || null, titulo: midia.caption || null,
      metricas: {
        visualizacoes: insights.visualizacoes, alcance: insights.alcance, curtidas: numero(midia.like_count),
        comentarios: numero(midia.comments_count), compartilhamentos: insights.compartilhamentos,
        salvamentos: insights.salvamentos, interacoes: insights.interacoes,
        tempoMedioReproducaoSegundos: insights.tempoMedioReproducaoSegundos,
        tempoTotalReproducaoSegundos: insights.tempoTotalReproducaoSegundos,
        taxaPuloPrimeiros3Segundos: insights.taxaPuloPrimeiros3Segundos,
      },
      ...(insights.aviso ? { aviso: insights.aviso } : {}),
    };
  }));
  const contaInsights = await metricasContaInstagram(env.META_IG_USER_ID!, versao, token, fetchImpl, base, periodo);
  return {
    conta: {
      id: conta.id, nome: conta.name || conta.username || null, seguidores: numero(conta.followers_count), publicacoesNoPeriodo: publicacoes.length,
      metricasPeriodo: contaInsights.metricasPeriodo,
    },
    publicacoes,
    avisos: [...publicacoes.flatMap((item) => item.aviso ? [`${item.id}: ${item.aviso}`] : []), ...contaInsights.avisos],
  };
}

function totalResumo(conteudos: any[], chave: string) {
  return conteudos.reduce((total, item) => total + (numero(item.metricas?.[chave]) || 0), 0);
}

async function metricasFacebookReel(videoId: string, versao: string, token: string, fetchImpl: FetchImpl) {
  try {
    const dados = await requisitarJson(urlApi(META_BASE, `/${versao}/${videoId}/video_insights`, {
      metric: 'fb_reels_total_plays,post_impressions_unique', period: 'lifetime',
    }), { token, fetchImpl });
    return {
      visualizacoes: valorInsight(dados, 'fb_reels_total_plays'),
      alcance: valorInsight(dados, 'post_impressions_unique'),
    };
  } catch (erro) {
    return { visualizacoes: null, alcance: null, aviso: textoErro(erro, [token]) };
  }
}

async function coletarFacebook({ env, periodo, fetchImpl }: ArgsColeta) {
  exigir(env, ['META_PAGE_ID', 'META_PAGE_ACCESS_TOKEN']);
  const versao = env.META_GRAPH_VERSION || 'v27.0';
  const token = env.META_PAGE_ACCESS_TOKEN;
  const conta = await requisitarJson(urlApi(META_BASE, `/${versao}/${env.META_PAGE_ID}`, {
    fields: 'id,name,followers_count,fan_count',
  }), { token, fetchImpl });
  const posts = await paginarGet(urlApi(META_BASE, `/${versao}/${env.META_PAGE_ID}/posts`, {
    fields: 'id,created_time,message,permalink_url,shares,reactions.limit(0).summary(true),comments.limit(0).summary(true),attachments{media_type,media,target,url}', limit: 100,
  }), { token, fetchImpl });
  const publicacoes = await Promise.all(posts.filter((post) => dataEstaNoPeriodo(post.created_time, periodo)).map(async (post) => {
    const anexo = post.attachments?.data?.[0];
    const tipo = anexo?.media_type || 'POST';
    const videoId = /video|reel/i.test(tipo) ? anexo?.target?.id || anexo?.media?.id : null;
    const insights = videoId ? await metricasFacebookReel(videoId, versao, token!, fetchImpl) : { visualizacoes: null, alcance: null };
    return {
      id: post.id, tipo, publicadoEm: post.created_time,
      url: post.permalink_url || null, titulo: post.message || null,
      metricas: {
        visualizacoes: insights.visualizacoes, alcance: insights.alcance, curtidas: numero(post.reactions?.summary?.total_count),
        comentarios: numero(post.comments?.summary?.total_count), compartilhamentos: numero(post.shares?.count), salvamentos: null,
      },
      ...(insights.aviso ? { aviso: insights.aviso } : {}),
    };
  }));
  return {
    conta: {
      id: conta.id, nome: conta.name || null, seguidores: numero(conta.followers_count ?? conta.fan_count),
      publicacoesNoPeriodo: publicacoes.length, curtidasNoPeriodo: totalResumo(publicacoes, 'curtidas'),
      comentariosNoPeriodo: totalResumo(publicacoes, 'comentarios'), compartilhamentosNoPeriodo: totalResumo(publicacoes, 'compartilhamentos'),
    },
    publicacoes,
    avisos: [
      ...publicacoes.flatMap((item) => item.aviso ? [`${item.id}: ${item.aviso}`] : []),
      'Visualizações e alcance de Reels exigem read_insights e token de Página com tarefa ANALYZE.',
    ],
  };
}

export const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';

// Converte a resposta do endpoint de token do TikTok nas chaves gravadas em .env.tiktok.
export function valoresTokenTikTok(resposta: any, agora = new Date()) {
  if (!resposta?.access_token || !resposta?.refresh_token) {
    const detalhe = resposta?.error_description || resposta?.error || resposta?.message || 'resposta sem access_token';
    throw new Error(`O TikTok não devolveu o token: ${detalhe}`);
  }
  const em = (segundos: unknown) => new Date(agora.getTime() + (Number(segundos) || 0) * 1000).toISOString();
  return {
    TIKTOK_ACCESS_TOKEN: resposta.access_token,
    TIKTOK_REFRESH_TOKEN: resposta.refresh_token,
    TIKTOK_TOKEN_EXPIRA_EM: em(resposta.expires_in),
    TIKTOK_REFRESH_EXPIRA_EM: em(resposta.refresh_expires_in),
    ...(resposta.open_id ? { TIKTOK_OPEN_ID: resposta.open_id } : {}),
  };
}

// O access token do TikTok dura poucas horas e o refresh token muda a cada renovação,
// por isso o novo par é gravado de volta (salvarEnv) e o env em memória é atualizado.
async function tokenTikTok(env: Env, fetchImpl: FetchImpl, salvarEnv?: SalvarEnv, agora = new Date()) {
  if (!env.TIKTOK_REFRESH_TOKEN) {
    if (env.TIKTOK_ACCESS_TOKEN) return env.TIKTOK_ACCESS_TOKEN;
    throw new Error('Configure no .env: TIKTOK_CLIENT_KEY e TIKTOK_CLIENT_SECRET, depois rode npm run tiktok:autorizar.');
  }
  const expira = env.TIKTOK_TOKEN_EXPIRA_EM ? Date.parse(env.TIKTOK_TOKEN_EXPIRA_EM) : NaN;
  if (env.TIKTOK_ACCESS_TOKEN && expira - agora.getTime() > 5 * 60 * 1000) return env.TIKTOK_ACCESS_TOKEN;
  exigir(env, ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET']);
  const resposta = await requisitarJson(TIKTOK_TOKEN_URL, {
    fetchImpl, method: 'POST', form: {
      client_key: env.TIKTOK_CLIENT_KEY!, client_secret: env.TIKTOK_CLIENT_SECRET!,
      grant_type: 'refresh_token', refresh_token: env.TIKTOK_REFRESH_TOKEN,
    },
  });
  let valores;
  try { valores = valoresTokenTikTok(resposta, agora); } catch (erro) {
    throw new Error(`${textoErro(erro)} Rode npm run tiktok:autorizar para autorizar de novo.`);
  }
  Object.assign(env, valores);
  salvarEnv?.(valores);
  return valores.TIKTOK_ACCESS_TOKEN;
}

async function coletarTikTok({ env, periodo, fetchImpl, salvarEnv, agora }: ArgsColeta) {
  const token = await tokenTikTok(env, fetchImpl, salvarEnv, agora);
  const camposConta = 'open_id,display_name,username,follower_count,following_count,likes_count,video_count';
  const contaResposta = await requisitarJson(urlApi(TIKTOK_BASE, '/user/info/', { fields: camposConta }), { token, fetchImpl });
  const conta = contaResposta.data?.user || contaResposta.data || {};
  const camposVideo = 'id,title,video_description,create_time,share_url,like_count,comment_count,share_count,view_count';
  const videos = [];
  let cursor = 0;
  let temMais = true;
  while (temMais) {
    const resposta = await requisitarJson(urlApi(TIKTOK_BASE, '/video/list/', { fields: camposVideo }), {
      token, fetchImpl, method: 'POST', body: { cursor, max_count: 20 },
    });
    const dados = resposta.data || {};
    videos.push(...(dados.videos || dados.video_list || []));
    temMais = Boolean(dados.has_more);
    cursor = dados.cursor;
    if (temMais && cursor === undefined) throw new Error('TikTok não devolveu cursor para a próxima página.');
  }
  const publicacoes = videos.filter((video) => dataEstaNoPeriodo(Number(video.create_time) * 1000, periodo)).map((video) => ({
    id: video.id, tipo: 'VIDEO', publicadoEm: new Date(Number(video.create_time) * 1000).toISOString(),
    url: video.share_url || null, titulo: video.title || video.video_description || null,
    metricas: {
      visualizacoes: numero(video.view_count), alcance: null, curtidas: numero(video.like_count),
      comentarios: numero(video.comment_count), compartilhamentos: numero(video.share_count), salvamentos: null,
    },
  }));
  return {
    conta: {
      id: conta.open_id || null, nome: conta.display_name || conta.username || null, seguidores: numero(conta.follower_count),
      seguindo: numero(conta.following_count), curtidasTotais: numero(conta.likes_count), publicacoesNoPeriodo: publicacoes.length,
    },
    publicacoes,
    avisos: ['A API do TikTok retorna apenas vídeos públicos da pessoa que autorizou o aplicativo.'],
  };
}

function blocos<T>(itens: T[], tamanho = 50) {
  return Array.from({ length: Math.ceil(itens.length / tamanho) }, (_, i) => itens.slice(i * tamanho, i * tamanho + tamanho));
}

export function duracaoIsoEmSegundos(duracao: unknown) {
  const partes = typeof duracao === 'string' && duracao.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!partes) return null;
  return Number(partes[1] || 0) * 3600 + Number(partes[2] || 0) * 60 + Number(partes[3] || 0);
}

async function coletarYouTube({ env, periodo, fetchImpl }: ArgsColeta) {
  const token = await tokenYouTube(env, fetchImpl);
  const canais = await requisitarJson(urlApi(YOUTUBE_BASE, '/channels', { part: 'snippet,statistics,contentDetails', mine: 'true' }), { token, fetchImpl });
  const canal = canais.items?.[0];
  if (!canal) throw new Error('Nenhum canal do YouTube foi encontrado para este token.');
  const playlist = canal.contentDetails?.relatedPlaylists?.uploads;
  if (!playlist) throw new Error('O canal não informou a playlist de uploads.');
  const itens = [];
  let pagina;
  do {
    const resposta = await requisitarJson(urlApi(YOUTUBE_BASE, '/playlistItems', {
      part: 'snippet,contentDetails', playlistId: playlist, maxResults: 50, ...(pagina ? { pageToken: pagina } : {}),
    }), { token, fetchImpl });
    itens.push(...(resposta.items || []));
    pagina = resposta.nextPageToken;
    const ultimo = itens.at(-1)?.contentDetails?.videoPublishedAt || itens.at(-1)?.snippet?.publishedAt;
    if (ultimo && !dataEstaNoPeriodo(ultimo, periodo)) pagina = undefined;
  } while (pagina);
  const recentes = itens.filter((item) => dataEstaNoPeriodo(item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt, periodo));
  const ids = recentes.map((item) => item.contentDetails?.videoId).filter(Boolean);
  const detalhes = new Map();
  for (const grupo of blocos(ids)) {
    const resposta = await requisitarJson(urlApi(YOUTUBE_BASE, '/videos', { part: 'snippet,statistics,contentDetails', id: grupo.join(',') }), { token, fetchImpl });
    for (const video of resposta.items || []) detalhes.set(video.id, video);
  }
  const indice = new Map();
  for (const id of ids) {
    const analytics = await requisitarJson(urlApi(YOUTUBE_ANALYTICS_BASE, '/reports', {
      ids: 'channel==MINE', startDate: periodo.desde, endDate: periodo.ate,
      filters: `video==${id}`, metrics: 'views,likes,comments,shares,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained',
    }), { token, fetchImpl });
    const linha = analytics.rows?.[0];
    if (linha) indice.set(id, Object.fromEntries((analytics.columnHeaders || []).map((coluna: any, i: number) => [coluna.name, linha[i]])));
  }
  const publicacoes = recentes.map((item) => {
    const video = detalhes.get(item.contentDetails.videoId) || {};
    const dados = indice.get(item.contentDetails.videoId) || {};
    return {
      id: item.contentDetails?.videoId, tipo: 'VIDEO', publicadoEm: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt,
      url: `https://www.youtube.com/watch?v=${item.contentDetails?.videoId}`, titulo: video.snippet?.title || item.snippet?.title || null,
      metricas: {
        visualizacoes: numero(video.statistics?.viewCount), alcance: null, curtidas: numero(video.statistics?.likeCount),
        comentarios: numero(video.statistics?.commentCount), compartilhamentos: null, salvamentos: null,
        duracaoSegundos: duracaoIsoEmSegundos(video.contentDetails?.duration),
      },
      metricasPeriodo: {
        visualizacoes: numero(dados.views), curtidas: numero(dados.likes), comentarios: numero(dados.comments),
        compartilhamentos: numero(dados.shares), minutosAssistidos: numero(dados.estimatedMinutesWatched), duracaoMediaAssistidaSegundos: numero(dados.averageViewDuration),
        percentualMedioAssistido: numero(dados.averageViewPercentage), inscritosGanhos: numero(dados.subscribersGained),
      },
    };
  });
  return {
    conta: { id: canal.id, nome: canal.snippet?.title || null, inscritos: numero(canal.statistics?.subscriberCount), publicacoesNoPeriodo: publicacoes.length },
    publicacoes,
    avisos: ['As métricas em metricasPeriodo são atividade no intervalo; metricas são os contadores atuais do vídeo.'],
  };
}

const COLETAS_PADRAO: Record<string, Coleta> = { instagram: coletarInstagram, facebook: coletarFacebook, tiktok: coletarTikTok, youtube: coletarYouTube };

export async function coletarMetricas({ env = {}, dias = 30, agora = new Date(), fetchImpl = fetch as unknown as FetchImpl, coletas = COLETAS_PADRAO, salvarEnv }: OpcoesColeta = {}): Promise<Relatorio> {
  const periodo = criarPeriodo(dias, agora);
  const resultados = await Promise.all(Object.entries(coletas).map(async ([nome, coleta]) => {
    try {
      const dados = await coleta({ env, periodo, fetchImpl, salvarEnv, agora });
      return [nome, { status: 'ok', ...dados }];
    } catch (erro) {
      const segredos = Object.entries(env).filter(([chave]) => chave.endsWith('_TOKEN') || chave.endsWith('_SECRET')).map(([, valor]) => valor).filter((valor): valor is string => Boolean(valor));
      return [nome, { status: 'erro', erro: textoErro(erro, segredos), conta: null, publicacoes: [], avisos: [] }];
    }
  }));
  const plataformas = Object.fromEntries(resultados) as Record<string, Plataforma>;
  return {
    geradoEm: agora.toISOString(), periodo, parcial: Object.values(plataformas).some((plataforma) => plataforma.status !== 'ok'), plataformas,
  };
}

export function resumoRelatorio(relatorio: Relatorio) {
  return Object.entries(relatorio.plataformas).map(([nome, plataforma]) => {
    if (plataforma.status !== 'ok') return `${nome}: ERRO — ${plataforma.erro}`;
    return `${nome}: ${plataforma.publicacoes.length} publicação(ões), ${plataforma.conta?.seguidores ?? plataforma.conta?.inscritos ?? '—'} seguidores/inscritos`;
  });
}

function argumentos(argv: string[]): Argumentos {
  const opcoes: Argumentos = { dias: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dias') opcoes.dias = Number(argv[++i]);
    else if (argv[i] === '--saida') opcoes.saida = argv[++i];
    else if (argv[i] === '--ajuda' || argv[i] === '-h') opcoes.ajuda = true;
    else throw new Error(`Argumento desconhecido: ${argv[i]}.`);
  }
  criarPeriodo(opcoes.dias);
  return opcoes;
}

function uso() {
  return 'Uso: npm run metricas -- [--dias 30] [--saida reports/arquivo.json]';
}

async function principal() {
  const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const opcoes = argumentos(process.argv.slice(2));
  if (opcoes.ajuda) return console.log(uso());
  lerEnv(raiz);
  const relatorio = await coletarMetricas({
    env: process.env, dias: opcoes.dias, salvarEnv: (valores) => gravarEnv(path.join(raiz, ARQUIVO_ENV_TIKTOK), valores),
  });
  const data = relatorio.geradoEm.slice(0, 10);
  const saida = path.resolve(raiz, opcoes.saida || path.join('reports', `metricas-${data}.json`));
  fs.mkdirSync(path.dirname(saida), { recursive: true });
  fs.writeFileSync(saida, `${JSON.stringify(relatorio, null, 2)}\n`);
  console.log(`Relatório salvo em ${path.relative(raiz, saida)}.`);
  for (const linha of resumoRelatorio(relatorio)) console.log(`- ${linha}`);
  if (relatorio.parcial) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().catch((erro) => { console.error(`Erro: ${textoErro(erro)}`); process.exitCode = 1; });
}
