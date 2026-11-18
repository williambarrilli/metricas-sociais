import assert from 'node:assert/strict';
import test from 'node:test';
import { coletarMetricas, criarPeriodo, paginarGet } from './metricas.js';

test('cria período de 30 dias no fuso de São Paulo', () => {
  assert.deepEqual(criarPeriodo(30, new Date('2026-11-18T12:00:00Z')), {
    dias: 30, fuso: 'America/Sao_Paulo', desde: '2026-10-20', ate: '2026-11-18',
  });
});

test('pagina respostas e preserva os itens', async () => {
  const respostas = new Map([
    ['https://api.exemplo.test/primeira', { data: [{ id: '1' }], paging: { next: 'https://api.exemplo.test/segunda' } }],
    ['https://api.exemplo.test/segunda', { data: [{ id: '2' }] }],
  ]);
  const fetchImpl = async (url: string) => ({ ok: true, status: 200, text: async () => JSON.stringify(respostas.get(url)) });
  assert.deepEqual(await paginarGet('https://api.exemplo.test/primeira', { fetchImpl }), [{ id: '1' }, { id: '2' }]);
});

test('gera relatório parcial sem expor token quando uma coleta falha', async () => {
  const relatorio = await coletarMetricas({
    env: { TEST_TOKEN: 'segredo-nao-vaza' }, agora: new Date('2026-11-18T12:00:00Z'),
    coletas: {
      ok: async () => ({ conta: { nome: 'Conta' }, publicacoes: [{ id: '1' }], avisos: [] }),
      falha: async () => { throw new Error('token segredo-nao-vaza expirou'); },
    },
  });
  assert.equal(relatorio.parcial, true);
  assert.equal(relatorio.plataformas.ok.status, 'ok');
  assert.equal(relatorio.plataformas.falha.status, 'erro');
  assert.ok(!relatorio.plataformas.falha.erro!.includes('segredo-nao-vaza'));
});

test('credenciais ausentes falham sem fazer chamadas HTTP', async () => {
  const relatorio = await coletarMetricas({
    env: {}, agora: new Date('2026-11-18T12:00:00Z'),
    fetchImpl: async () => { throw new Error('não deveria chamar a rede'); },
  });
  assert.equal(relatorio.parcial, true);
  for (const plataforma of Object.values(relatorio.plataformas)) {
    assert.equal(plataforma.status, 'erro');
    assert.match(plataforma.erro!, /Configure no .env/);
  }
});

test('usa graph.instagram.com para token do novo Instagram Login', async () => {
  const chamadas: URL[] = [];
  const fetchImpl = async (url: string) => {
    const alvo = new URL(url);
    chamadas.push(alvo);
    let resposta = {};
    if (alvo.pathname.endsWith('/media')) resposta = { data: [] };
    else if (alvo.hostname === 'graph.instagram.com') resposta = { id: 'ig-1', username: 'bora', followers_count: 10 };
    return { ok: true, status: 200, text: async () => JSON.stringify(resposta) };
  };
  const relatorio = await coletarMetricas({
    env: { META_IG_LOGIN: 'instagram', META_IG_USER_ID: 'ig-1', META_IG_ACCESS_TOKEN: 'token-de-teste' },
    fetchImpl,
  });
  assert.equal(relatorio.plataformas.instagram.status, 'ok');
  assert.ok(chamadas.every((url: URL) => url.hostname === 'graph.instagram.com'));
});

test('consulta Analytics por vídeo com o filtro aceito pela API', async () => {
  const chamadasAnalytics: URL[] = [];
  const fetchImpl = async (url: string) => {
    const alvo = new URL(url);
    let resposta;
    if (alvo.hostname === 'www.googleapis.com' && alvo.pathname === '/youtube/v3/channels') {
      resposta = { items: [{ id: 'canal-1', snippet: { title: 'Canal' }, statistics: { subscriberCount: '10' }, contentDetails: { relatedPlaylists: { uploads: 'uploads-1' } } }] };
    } else if (alvo.hostname === 'www.googleapis.com' && alvo.pathname === '/youtube/v3/playlistItems') {
      resposta = { items: [{ contentDetails: { videoId: 'video-1', videoPublishedAt: '2026-11-18T12:00:00Z' }, snippet: { title: 'Vídeo', publishedAt: '2026-11-18T12:00:00Z' } }] };
    } else if (alvo.hostname === 'www.googleapis.com' && alvo.pathname === '/youtube/v3/videos') {
      resposta = { items: [{ id: 'video-1', snippet: { title: 'Vídeo' }, statistics: { viewCount: '20', likeCount: '3', commentCount: '2' } }] };
    } else if (alvo.hostname === 'youtubeanalytics.googleapis.com') {
      chamadasAnalytics.push(alvo);
      resposta = { columnHeaders: [{ name: 'views' }, { name: 'likes' }, { name: 'comments' }, { name: 'shares' }, { name: 'estimatedMinutesWatched' }, { name: 'averageViewDuration' }], rows: [[7, 2, 1, 0, 4, 30]] };
    } else throw new Error(`URL inesperada: ${url}`);
    return { ok: true, status: 200, text: async () => JSON.stringify(resposta) };
  };
  const relatorio = await coletarMetricas({
    env: { YOUTUBE_ACCESS_TOKEN: 'token-de-teste' }, dias: 1, agora: new Date('2026-11-18T12:00:00Z'), fetchImpl,
  });
  assert.equal(relatorio.plataformas.youtube.status, 'ok');
  assert.equal(relatorio.plataformas.youtube.publicacoes[0].metricasPeriodo.visualizacoes, 7);
  assert.equal(chamadasAnalytics.length, 1);
  assert.equal(chamadasAnalytics[0].searchParams.get('filters'), 'video==video-1');
  assert.equal(chamadasAnalytics[0].searchParams.has('dimensions'), false);
});

test('renova o token do YouTube sem expor o client secret', async () => {
  const env = { YOUTUBE_CLIENT_ID: 'cliente', YOUTUBE_CLIENT_SECRET: 'segredo-cliente', YOUTUBE_REFRESH_TOKEN: 'refresh-token' };
  let requisicaoToken: any;
  const fetchImpl = async (url: string, opcoes: any) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      requisicaoToken = opcoes;
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'access-renovado' }) };
    }
    assert.equal(opcoes.headers.Authorization, 'Bearer access-renovado');
    return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: `falha ${env.YOUTUBE_CLIENT_SECRET}` } }) };
  };
  const relatorio = await coletarMetricas({ env, fetchImpl });
  assert.equal(requisicaoToken.method, 'POST');
  assert.equal(requisicaoToken.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(requisicaoToken.body, 'client_id=cliente&client_secret=segredo-cliente&refresh_token=refresh-token&grant_type=refresh_token');
  assert.equal(relatorio.plataformas.youtube.status, 'erro');
  assert.ok(!relatorio.plataformas.youtube.erro!.includes(env.YOUTUBE_CLIENT_SECRET));
});
