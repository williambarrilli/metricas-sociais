# Métricas sociais

Projeto Node independente que consulta somente dados autorizados e nunca publica, altera ou apaga conteúdo.

Requer Node 18 ou superior. Não possui dependências externas.

```bash
cp .env.example .env
# preencha o .env com os tokens das contas
npm install
npm test
```

O comando abaixo coleta as métricas:

```bash
npm run metricas -- --dias 30
```

Ele cria `reports/metricas-AAAA-MM-DD.json` e mostra um resumo curto no terminal. Para escolher outro arquivo, use `--saida caminho/arquivo.json`.

## Antes de rodar

Copie `.env.example` para `.env` se ainda não existir e preencha apenas as variáveis das redes que quiser consultar. O `.env` é ignorado pelo Git: não cole tokens no código, em issues ou no relatório.

| Rede | Variáveis | Acesso necessário |
|---|---|---|
| Instagram profissional | `META_IG_LOGIN=instagram`, `META_IG_USER_ID`, `META_IG_ACCESS_TOKEN` | No Graph API Explorer, escolha `graph.instagram.com`, gere o Instagram Access Token com acesso a Insights e consulte `me?fields=id,username,media_count`. O `id` retornado é o `META_IG_USER_ID`. |
| Página Facebook | `META_PAGE_ID`, `META_PAGE_ACCESS_TOKEN` | Token de Página emitido por alguém com tarefa **ANALYZE**, `pages_manage_engagement` e `read_insights`. |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` (+ tokens em `.env.tiktok`) | App "tiktok" no TikTok for Developers, Sandbox **metricas**: Login Kit com Desktop Redirect URI `http://localhost:3455/callback/`, escopos `user.info.basic`, `user.info.profile`, `user.info.stats` e `video.list`, usuário de teste @bora.descobrir93. |
| YouTube | `YOUTUBE_ACCESS_TOKEN` ou `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` e `YOUTUBE_REFRESH_TOKEN` | OAuth com `youtube.readonly` e `yt-analytics.readonly`. |

Os tokens são obtidos nos painéis de desenvolvedor de cada plataforma. Para o YouTube, se `YOUTUBE_REFRESH_TOKEN`, `YOUTUBE_CLIENT_ID` e `YOUTUBE_CLIENT_SECRET` estiverem preenchidos, o script renova o access token a cada coleta; caso contrário, usa `YOUTUBE_ACCESS_TOKEN` diretamente. O script não abre login OAuth.

O token gerado em `graph.instagram.com` não precisa de Página Facebook. Para ele, mantenha `META_IG_LOGIN=instagram`; o coletor usará a API do Instagram. Para tokens antigos do Facebook Login, remova essa variável.

## TikTok: autorizar uma vez

```bash
npm run tiktok:autorizar
```

O comando pede o Client secret se ele ainda não estiver salvo, abre o link de autorização no navegador e espera o retorno em `http://localhost:3455/callback/`. Entre com a conta do canal e clique em Autorizar. Os tokens vão para `.env.tiktok` (ignorado pelo Git).

O access token do TikTok vale cerca de 2 horas e o refresh token cerca de 180 dias, e o refresh token muda a cada renovação. Por isso `npm run metricas` renova o token quando precisa e grava o par novo em `.env.tiktok`. Não edite esse arquivo à mão; se a renovação falhar (por exemplo, após 180 dias sem uso), rode `npm run tiktok:autorizar` de novo.

O app está em Sandbox: só funciona para os usuários de teste cadastrados no portal, o que basta para ler as métricas do próprio canal.

## Resultado

Cada rede informa `status: "ok"` ou `status: "erro"`. Uma falha não impede as outras coletas; o arquivo é gravado com o que foi obtido e o comando termina com código `1` para sinalizar relatório parcial.

Em `publicacoes`, `metricas` representa os contadores atuais expostos pela API. O YouTube também inclui `metricasPeriodo`, que representa a atividade entre as datas solicitadas. Campos indisponíveis ficam como `null`; o script não estima alcance, visualizações ou retenção.

Para Reels do Instagram, `metricas` também traz `tempoMedioReproducaoSegundos`, `tempoTotalReproducaoSegundos` e `taxaPuloPrimeiros3Segundos`. Os dois tempos são convertidos de milissegundos para segundos; a taxa continua em porcentagem. Em `conta.metricasPeriodo`, o Instagram informa visitas ao perfil, seguidores ganhos/perdidos e visualizações de seguidores e não seguidores quando esses Insights estiverem liberados.

No YouTube, `metricas.duracaoSegundos` é a duração do vídeo, enquanto `metricasPeriodo.percentualMedioAssistido` e `metricasPeriodo.inscritosGanhos` se referem ao intervalo solicitado. Por vídeo, os inscritos ganhos são apenas os originados da página de exibição daquele vídeo.

## Limites

- TikTok retorna apenas vídeos públicos do usuário que autorizou o aplicativo.
- Para Reels da Página Facebook, o script consulta `/{video-id}/video_insights`: visualizações vêm de `fb_reels_total_plays` e alcance de `post_impressions_unique`. Sem `read_insights`, tarefa **ANALYZE** ou ID de vídeo no anexo do post, esses campos ficam como `null` e o aviso explica o motivo.
- Algumas métricas podem atrasar, ser agregadas ou mudar de nome pelas plataformas. Confira o aviso da rede antes de comparar períodos.

Referências: [Meta Insights](https://developers.facebook.com/docs/insights/get-started), [TikTok scopes](https://developers.tiktok.com/docs/en/tiktok-api-scopes) e [YouTube Analytics](https://developers.google.com/youtube/analytics/channel_reports).
