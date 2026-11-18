// Coleta somente métricas públicas/autorizadas; tokens ficam exclusivamente no .env.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function lerEnv(raiz) {
  const arquivo = path.join(raiz, '.env');
  if (!fs.existsSync(arquivo)) return;
  for (const linha of fs.readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
    const dado = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (dado && !process.env[dado[1]]) process.env[dado[1]] = dado[2].replace(/^["']|["']$/g, '');
  }
}

const TZ = 'America/Sao_Paulo';
const META_BASE = 'https://graph.facebook.com';
const TIKTOK_BASE = 'https://open.tiktokapis.com/v2';
const YOUTUBE_BASE = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_ANALYTICS_BASE = 'https://youtubeanalytics.googleapis.com/v2';

function dataNoFuso(data, timeZone = TZ) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(data).reduce((acc, parte) => ({ ...acc, [parte.type]: parte.value }), {});
  return `${partes.year}-${partes.month}-${partes.day}`;
}

function adicionarDias(dataIso, dias) {
  const data = new Date(`${dataIso}T00:00:00Z`);
  data.setUTCDate(data.getUTCDate() + dias);
  return data.toISOString().slice(0, 10);
}

export function criarPeriodo(dias = 30, agora = new Date()) {
  if (!Number.isInteger(dias) || dias < 1) throw new Error('--dias deve ser um número inteiro maior que zero.');
  const ate = dataNoFuso(agora);
  return { dias, fuso: TZ, desde: adicionarDias(ate, 1 - dias), ate };
}

function dataEstaNoPeriodo(data, periodo) {
  if (!data) return false;
  const iso = new Date(data).toISOString().slice(0, 10);
  return iso >= periodo.desde && iso <= periodo.ate;
}

function numero(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

function textoErro(erro, segredos = []) {
  let texto = erro instanceof Error ? erro.message : String(erro);
  for (const segredo of segredos.filter(Boolean)) texto = texto.replaceAll(segredo, '[oculto]');
  return texto.slice(0, 500);
}

function exigir(env, campos) {
  const faltando = campos.filter((campo) => !env[campo]);
  if (faltando.length) throw new Error(`Configure no .env: ${faltando.join(', ')}.`);
}

function urlApi(base, caminho, parametros = {}) {
  const url = new URL(caminho.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`);
  for (const [chave, valor] of Object.entries(parametros)) {
    if (valor !== undefined && valor !== null && valor !== '') url.searchParams.set(chave, String(valor));
  }
  return url.toString();
}

async function requisitarJson(url, { fetchImpl = fetch, token, method = 'GET', body } = {}) {
  const resposta = await fetchImpl(url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
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

export async function paginarGet(url, opcoes = {}) {
  const itens = [];
  let proxima = url;
  while (proxima) {
    const json = await requisitarJson(proxima, opcoes);
    itens.push(...(json.data || []));
    proxima = json.paging?.next || null;
  }
  return itens;
}

function valorInsight(insights, nome) {
  const insight = (insights.data || []).find((item) => item.name === nome);
  const valores = insight?.values || [];
  return numero(valores.at(-1)?.value ?? insight?.value);
}

async function metricasInstagram(mid, versao, token, fetchImpl) {
  try {
    const dados = await requisitarJson(urlApi(META_BASE, `/${versao}/${mid}/insights`, {
      metric: 'views,reach,shares,saved,total_interactions',
    }), { token, fetchImpl });
    return {
      visualizacoes: valorInsight(dados, 'views'), alcance: valorInsight(dados, 'reach'),
      compartilhamentos: valorInsight(dados, 'shares'), salvamentos: valorInsight(dados, 'saved'),
      interacoes: valorInsight(dados, 'total_interactions'),
    };
  } catch (erro) {
    return { visualizacoes: null, alcance: null, compartilhamentos: null, salvamentos: null, interacoes: null, aviso: textoErro(erro, [token]) };
  }
}

async function coletarInstagram({ env, periodo, fetchImpl }) {
  exigir(env, ['META_IG_USER_ID', 'META_IG_ACCESS_TOKEN']);
  const versao = env.META_GRAPH_VERSION || 'v27.0';
  const token = env.META_IG_ACCESS_TOKEN;
  const conta = await requisitarJson(urlApi(META_BASE, `/${versao}/${env.META_IG_USER_ID}`, {
    fields: 'id,username,name,followers_count,media_count',
  }), { token, fetchImpl });
  const midias = await paginarGet(urlApi(META_BASE, `/${versao}/${env.META_IG_USER_ID}/media`, {
    fields: 'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count', limit: 100,
  }), { token, fetchImpl });
  const recentes = midias.filter((midia) => dataEstaNoPeriodo(midia.timestamp, periodo));
  const publicacoes = await Promise.all(recentes.map(async (midia) => {
    const insights = await metricasInstagram(midia.id, versao, token, fetchImpl);
    return {
      id: midia.id, tipo: midia.media_product_type || midia.media_type, publicadoEm: midia.timestamp,
      url: midia.permalink || null, titulo: midia.caption || null,
      metricas: {
        visualizacoes: insights.visualizacoes, alcance: insights.alcance, curtidas: numero(midia.like_count),
        comentarios: numero(midia.comments_count), compartilhamentos: insights.compartilhamentos,
        salvamentos: insights.salvamentos, interacoes: insights.interacoes,
      },
      ...(insights.aviso ? { aviso: insights.aviso } : {}),
    };
  }));
  return {
    conta: { id: conta.id, nome: conta.name || conta.username || null, seguidores: numero(conta.followers_count), publicacoesNoPeriodo: publicacoes.length },
    publicacoes,
    avisos: publicacoes.flatMap((item) => item.aviso ? [`${item.id}: ${item.aviso}`] : []),
  };
}

function totalResumo(conteudos, chave) {
  return conteudos.reduce((total, item) => total + (numero(item.metricas?.[chave]) || 0), 0);
}

async function coletarFacebook({ env, periodo, fetchImpl }) {
  exigir(env, ['META_PAGE_ID', 'META_PAGE_ACCESS_TOKEN']);
  const versao = env.META_GRAPH_VERSION || 'v27.0';
  const token = env.META_PAGE_ACCESS_TOKEN;
  const conta = await requisitarJson(urlApi(META_BASE, `/${versao}/${env.META_PAGE_ID}`, {
    fields: 'id,name,followers_count,fan_count',
  }), { token, fetchImpl });
  const posts = await paginarGet(urlApi(META_BASE, `/${versao}/${env.META_PAGE_ID}/posts`, {
    fields: 'id,created_time,message,permalink_url,shares,reactions.limit(0).summary(true),comments.limit(0).summary(true),attachments{media_type,media,url}', limit: 100,
  }), { token, fetchImpl });
  const publicacoes = posts.filter((post) => dataEstaNoPeriodo(post.created_time, periodo)).map((post) => ({
    id: post.id, tipo: post.attachments?.data?.[0]?.media_type || 'POST', publicadoEm: post.created_time,
    url: post.permalink_url || null, titulo: post.message || null,
    metricas: {
      visualizacoes: null, alcance: null, curtidas: numero(post.reactions?.summary?.total_count),
      comentarios: numero(post.comments?.summary?.total_count), compartilhamentos: numero(post.shares?.count), salvamentos: null,
    },
  }));
  return {
    conta: {
      id: conta.id, nome: conta.name || null, seguidores: numero(conta.followers_count ?? conta.fan_count),
      publicacoesNoPeriodo: publicacoes.length, curtidasNoPeriodo: totalResumo(publicacoes, 'curtidas'),
      comentariosNoPeriodo: totalResumo(publicacoes, 'comentarios'), compartilhamentosNoPeriodo: totalResumo(publicacoes, 'compartilhamentos'),
    },
    publicacoes,
    avisos: ['Alcance e visualizações da Página só aparecem quando a permissão e a métrica de Insights estiverem disponíveis para a conta.'],
  };
}

async function coletarTikTok({ env, periodo, fetchImpl }) {
  exigir(env, ['TIKTOK_ACCESS_TOKEN']);
  const token = env.TIKTOK_ACCESS_TOKEN;
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

function blocos(itens, tamanho = 50) {
  return Array.from({ length: Math.ceil(itens.length / tamanho) }, (_, i) => itens.slice(i * tamanho, i * tamanho + tamanho));
}

async function coletarYouTube({ env, periodo, fetchImpl }) {
  exigir(env, ['YOUTUBE_ACCESS_TOKEN']);
  const token = env.YOUTUBE_ACCESS_TOKEN;
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
    const resposta = await requisitarJson(urlApi(YOUTUBE_BASE, '/videos', { part: 'snippet,statistics', id: grupo.join(',') }), { token, fetchImpl });
    for (const video of resposta.items || []) detalhes.set(video.id, video);
  }
  const analytics = await requisitarJson(urlApi(YOUTUBE_ANALYTICS_BASE, '/reports', {
    ids: 'channel==MINE', startDate: periodo.desde, endDate: periodo.ate,
    dimensions: 'video', metrics: 'views,likes,comments,shares,estimatedMinutesWatched,averageViewDuration',
  }), { token, fetchImpl });
  const indice = new Map((analytics.rows || []).map((linha) => Object.fromEntries((analytics.columnHeaders || []).map((coluna, i) => [coluna.name, linha[i]]))).map((linha) => [linha.video, linha]));
  const publicacoes = recentes.map((item) => {
    const video = detalhes.get(item.contentDetails.videoId) || {};
    const dados = indice.get(item.contentDetails.videoId) || {};
    return {
      id: item.contentDetails?.videoId, tipo: 'VIDEO', publicadoEm: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt,
      url: `https://www.youtube.com/watch?v=${item.contentDetails?.videoId}`, titulo: video.snippet?.title || item.snippet?.title || null,
      metricas: {
        visualizacoes: numero(video.statistics?.viewCount), alcance: null, curtidas: numero(video.statistics?.likeCount),
        comentarios: numero(video.statistics?.commentCount), compartilhamentos: null, salvamentos: null,
      },
      metricasPeriodo: {
        visualizacoes: numero(dados.views), curtidas: numero(dados.likes), comentarios: numero(dados.comments),
        compartilhamentos: numero(dados.shares), minutosAssistidos: numero(dados.estimatedMinutesWatched), duracaoMediaAssistidaSegundos: numero(dados.averageViewDuration),
      },
    };
  });
  return {
    conta: { id: canal.id, nome: canal.snippet?.title || null, inscritos: numero(canal.statistics?.subscriberCount), publicacoesNoPeriodo: publicacoes.length },
    publicacoes,
    avisos: ['As métricas em metricasPeriodo são atividade no intervalo; metricas são os contadores atuais do vídeo.'],
  };
}

const COLETAS_PADRAO = { instagram: coletarInstagram, facebook: coletarFacebook, tiktok: coletarTikTok, youtube: coletarYouTube };

export async function coletarMetricas({ env, dias = 30, agora = new Date(), fetchImpl = fetch, coletas = COLETAS_PADRAO } = {}) {
  const periodo = criarPeriodo(dias, agora);
  const resultados = await Promise.all(Object.entries(coletas).map(async ([nome, coleta]) => {
    try {
      const dados = await coleta({ env, periodo, fetchImpl });
      return [nome, { status: 'ok', ...dados }];
    } catch (erro) {
      const segredos = Object.entries(env || {}).filter(([chave]) => chave.endsWith('_TOKEN')).map(([, valor]) => valor);
      return [nome, { status: 'erro', erro: textoErro(erro, segredos), conta: null, publicacoes: [], avisos: [] }];
    }
  }));
  const plataformas = Object.fromEntries(resultados);
  return {
    geradoEm: agora.toISOString(), periodo, parcial: Object.values(plataformas).some((plataforma) => plataforma.status !== 'ok'), plataformas,
  };
}

export function resumoRelatorio(relatorio) {
  return Object.entries(relatorio.plataformas).map(([nome, plataforma]) => {
    if (plataforma.status !== 'ok') return `${nome}: ERRO — ${plataforma.erro}`;
    return `${nome}: ${plataforma.publicacoes.length} publicação(ões), ${plataforma.conta?.seguidores ?? plataforma.conta?.inscritos ?? '—'} seguidores/inscritos`;
  });
}

function argumentos(argv) {
  const opcoes = { dias: 30 };
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
  const relatorio = await coletarMetricas({ env: process.env, dias: opcoes.dias });
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
