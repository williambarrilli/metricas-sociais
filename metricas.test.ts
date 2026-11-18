import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coletarMetricas, criarPeriodo, duracaoIsoEmSegundos, gravarEnv, paginarGet } from './metricas.js';

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
      resposta = { items: [{ id: 'video-1', snippet: { title: 'Vídeo' }, statistics: { viewCount: '20', likeCount: '3', commentCount: '2' }, contentDetails: { duration: 'PT1M5S' } }] };
    } else if (alvo.hostname === 'youtubeanalytics.googleapis.com') {
      chamadasAnalytics.push(alvo);
      resposta = { columnHeaders: [{ name: 'views' }, { name: 'likes' }, { name: 'comments' }, { name: 'shares' }, { name: 'estimatedMinutesWatched' }, { name: 'averageViewDuration' }, { name: 'averageViewPercentage' }, { name: 'subscribersGained' }], rows: [[7, 2, 1, 0, 4, 30, 46.15, 2]] };
    } else throw new Error(`URL inesperada: ${url}`);
    return { ok: true, status: 200, text: async () => JSON.stringify(resposta) };
  };
  const relatorio = await coletarMetricas({
    env: { YOUTUBE_ACCESS_TOKEN: 'token-de-teste' }, dias: 1, agora: new Date('2026-11-18T12:00:00Z'), fetchImpl,
  });
  assert.equal(relatorio.plataformas.youtube.status, 'ok');
  assert.equal(relatorio.plataformas.youtube.publicacoes[0].metricasPeriodo.visualizacoes, 7);
  assert.equal(relatorio.plataformas.youtube.publicacoes[0].metricas.duracaoSegundos, 65);
  assert.equal(relatorio.plataformas.youtube.publicacoes[0].metricasPeriodo.percentualMedioAssistido, 46.15);
  assert.equal(relatorio.plataformas.youtube.publicacoes[0].metricasPeriodo.inscritosGanhos, 2);
  assert.equal(chamadasAnalytics.length, 1);
  assert.equal(chamadasAnalytics[0].searchParams.get('filters'), 'video==video-1');
  assert.equal(chamadasAnalytics[0].searchParams.has('dimensions'), false);
  assert.match(chamadasAnalytics[0].searchParams.get('metrics')!, /averageViewPercentage,subscribersGained/);
});

test('converte duração ISO 8601 do YouTube para segundos', () => {
  assert.equal(duracaoIsoEmSegundos('PT1H2M3S'), 3723);
  assert.equal(duracaoIsoEmSegundos('PT59S'), 59);
  assert.equal(duracaoIsoEmSegundos('inválida'), null);
});

test('inclui métricas de retenção em segundos somente para Reels do Instagram', async () => {
  const fetchImpl = async (url: string) => {
    const alvo = new URL(url);
    let resposta: any = {};
    if (alvo.pathname.endsWith('/media')) {
      resposta = { data: [
        { id: 'reel-1', media_product_type: 'REELS', timestamp: '2026-11-18T12:00:00Z', caption: 'Reel' },
        { id: 'foto-1', media_type: 'IMAGE', timestamp: '2026-11-18T12:00:00Z', caption: 'Foto' },
      ] };
    } else if (alvo.pathname.endsWith('/insights')) {
      const metric = alvo.searchParams.get('metric');
      if (metric === 'views,reach,shares,saved,total_interactions') resposta = { data: [{ name: 'views', values: [{ value: 10 }] }] };
      else if (metric === 'ig_reels_avg_watch_time,ig_reels_video_view_total_time,reels_skip_rate') resposta = { data: [
        { name: 'ig_reels_avg_watch_time', values: [{ value: 2500 }] },
        { name: 'ig_reels_video_view_total_time', values: [{ value: 12000 }] },
        { name: 'reels_skip_rate', values: [{ value: 12.5 }] },
      ] };
      else if (metric === 'profile_views') resposta = { data: [{ name: 'profile_views', values: [{ value: 4 }, { value: 6 }] }] };
      else if (metric === 'follows_and_unfollows') resposta = { data: [{ name: 'follows_and_unfollows', values: [{ value: { follows: 3, unfollows: 1 } }] }] };
      else if (metric === 'views') resposta = { data: [{ name: 'views', total_value: { breakdowns: [{ results: [
        { dimension_values: ['FOLLOWER'], value: 7 }, { dimension_values: ['NON_FOLLOWER'], value: 9 },
      ] }] } }] };
    } else resposta = { id: 'ig-1', username: 'bora', followers_count: 10 };
    return { ok: true, status: 200, text: async () => JSON.stringify(resposta) };
  };
  const relatorio = await coletarMetricas({
    env: { META_IG_LOGIN: 'instagram', META_IG_USER_ID: 'ig-1', META_IG_ACCESS_TOKEN: 'token-de-teste' },
    dias: 1, agora: new Date('2026-11-18T12:00:00Z'), fetchImpl,
  });
  const [reel, foto] = relatorio.plataformas.instagram.publicacoes;
  assert.equal(reel.metricas.tempoMedioReproducaoSegundos, 2.5);
  assert.equal(reel.metricas.tempoTotalReproducaoSegundos, 12);
  assert.equal(reel.metricas.taxaPuloPrimeiros3Segundos, 12.5);
  assert.equal(foto.metricas.tempoMedioReproducaoSegundos, null);
  assert.deepEqual(relatorio.plataformas.instagram.conta.metricasPeriodo, {
    visitasPerfil: 10, seguidoresGanhos: 3, seguidoresPerdidos: 1, visualizacoesSeguidores: 7, visualizacoesNaoSeguidores: 9,
  });
});

test('consulta insights do vídeo do Reel da Página', async () => {
  const fetchImpl = async (url: string) => {
    const alvo = new URL(url);
    let resposta: any = {};
    if (alvo.pathname.endsWith('/posts')) resposta = { data: [{
      id: 'post-1', created_time: '2026-11-18T12:00:00Z', attachments: { data: [{ media_type: 'video_autoplay', target: { id: 'video-1' } }] },
    }] };
    else if (alvo.pathname.endsWith('/video-1/video_insights')) resposta = { data: [
      { name: 'fb_reels_total_plays', values: [{ value: 15 }] }, { name: 'post_impressions_unique', values: [{ value: 12 }] },
    ] };
    else resposta = { id: 'page-1', name: 'Página' };
    return { ok: true, status: 200, text: async () => JSON.stringify(resposta) };
  };
  const relatorio = await coletarMetricas({
    env: { META_PAGE_ID: 'page-1', META_PAGE_ACCESS_TOKEN: 'token-de-teste' },
    dias: 1, agora: new Date('2026-11-18T12:00:00Z'), fetchImpl,
  });
  assert.equal(relatorio.plataformas.facebook.publicacoes[0].metricas.visualizacoes, 15);
  assert.equal(relatorio.plataformas.facebook.publicacoes[0].metricas.alcance, 12);
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

test('renova o token do TikTok, grava o novo refresh token e não expõe o segredo', async () => {
  const env: Record<string, string | undefined> = {
    TIKTOK_CLIENT_KEY: 'chave', TIKTOK_CLIENT_SECRET: 'segredo-tiktok', TIKTOK_REFRESH_TOKEN: 'refresh-antigo',
    TIKTOK_ACCESS_TOKEN: 'access-vencido', TIKTOK_TOKEN_EXPIRA_EM: '2026-11-18T11:00:00.000Z',
  };
  let corpoToken = '';
  const salvos: Record<string, string>[] = [];
  const fetchImpl = async (url: string, opcoes: any) => {
    const alvo = new URL(url);
    let resposta: any;
    if (url === 'https://open.tiktokapis.com/v2/oauth/token/') {
      corpoToken = opcoes.body;
      resposta = { access_token: 'access-novo', refresh_token: 'refresh-novo', expires_in: 7200, refresh_expires_in: 15552000, open_id: 'open-1' };
    } else {
      assert.equal(opcoes.headers.Authorization, 'Bearer access-novo');
      if (alvo.pathname === '/v2/user/info/') resposta = { data: { user: { open_id: 'open-1', display_name: 'Bora', follower_count: 50 } }, error: { code: 'ok' } };
      else if (alvo.pathname === '/v2/video/list/') resposta = { data: { videos: [{ id: 'v1', create_time: 1795003200, view_count: 120, like_count: 9 }], has_more: false, cursor: 0 }, error: { code: 'ok' } };
      else throw new Error(`URL inesperada: ${url}`);
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(resposta) };
  };
  const relatorio = await coletarMetricas({
    env, agora: new Date('2026-11-18T12:00:00Z'), fetchImpl, salvarEnv: (valores) => { salvos.push(valores); },
  });
  assert.equal(relatorio.plataformas.tiktok.status, 'ok');
  assert.equal(relatorio.plataformas.tiktok.conta.seguidores, 50);
  assert.equal(relatorio.plataformas.tiktok.publicacoes[0].metricas.visualizacoes, 120);
  assert.equal(corpoToken, 'client_key=chave&client_secret=segredo-tiktok&grant_type=refresh_token&refresh_token=refresh-antigo');
  assert.equal(salvos.length, 1);
  assert.equal(salvos[0].TIKTOK_REFRESH_TOKEN, 'refresh-novo');
  assert.equal(salvos[0].TIKTOK_TOKEN_EXPIRA_EM, '2026-11-18T14:00:00.000Z');
  assert.ok(!JSON.stringify(relatorio).includes('segredo-tiktok'));
});

test('usa o access token do TikTok ainda válido sem renovar', async () => {
  const env = {
    TIKTOK_CLIENT_KEY: 'chave', TIKTOK_CLIENT_SECRET: 'segredo', TIKTOK_REFRESH_TOKEN: 'refresh',
    TIKTOK_ACCESS_TOKEN: 'access-valido', TIKTOK_TOKEN_EXPIRA_EM: '2026-11-18T13:00:00.000Z',
  };
  const fetchImpl = async (url: string, opcoes: any) => {
    assert.notEqual(url, 'https://open.tiktokapis.com/v2/oauth/token/');
    assert.equal(opcoes.headers.Authorization, 'Bearer access-valido');
    const resposta = url.includes('/user/info/') ? { data: { user: {} } } : { data: { videos: [], has_more: false } };
    return { ok: true, status: 200, text: async () => JSON.stringify(resposta) };
  };
  const relatorio = await coletarMetricas({ env, agora: new Date('2026-11-18T12:00:00Z'), fetchImpl, salvarEnv: () => assert.fail('não deveria salvar') });
  assert.equal(relatorio.plataformas.tiktok.status, 'ok');
});

test('gravarEnv atualiza chaves existentes e preserva as outras linhas', () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'metricas-'));
  const arquivo = path.join(pasta, '.env.tiktok');
  fs.writeFileSync(arquivo, '# comentário\nTIKTOK_CLIENT_KEY=chave\nTIKTOK_REFRESH_TOKEN=velho\n');
  gravarEnv(arquivo, { TIKTOK_REFRESH_TOKEN: 'novo', TIKTOK_ACCESS_TOKEN: 'access' });
  assert.equal(fs.readFileSync(arquivo, 'utf8'), '# comentário\nTIKTOK_CLIENT_KEY=chave\nTIKTOK_REFRESH_TOKEN=novo\nTIKTOK_ACCESS_TOKEN=access\n');
});
