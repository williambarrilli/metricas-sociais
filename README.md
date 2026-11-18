# Métricas sociais

Projeto Node independente que consulta somente dados autorizados e nunca publica, altera ou apaga conteúdo.

Requer Node 18 ou superior. Não possui dependências externas.

```bash
cp .env.example .env
# preencha o .env com os tokens das contas
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
| Instagram profissional | `META_IG_USER_ID`, `META_IG_ACCESS_TOKEN` | Conta profissional autorizada para leitura de perfil, mídia e Insights. |
| Página Facebook | `META_PAGE_ID`, `META_PAGE_ACCESS_TOKEN` | Página administrada/analisável, com leitura de engajamento e Insights. |
| TikTok | `TIKTOK_ACCESS_TOKEN` | Aplicativo TikTok autorizado com `user.info.basic`, `user.info.stats` e `video.list`. |
| YouTube | `YOUTUBE_ACCESS_TOKEN` | OAuth com `youtube.readonly` e `yt-analytics.readonly`. |

Os tokens são obtidos uma vez nos painéis de desenvolvedor de cada plataforma. Esta primeira versão não abre login OAuth nem renova tokens: quando um token expirar, gere e substitua-o no `.env`.

## Resultado

Cada rede informa `status: "ok"` ou `status: "erro"`. Uma falha não impede as outras coletas; o arquivo é gravado com o que foi obtido e o comando termina com código `1` para sinalizar relatório parcial.

Em `publicacoes`, `metricas` representa os contadores atuais expostos pela API. O YouTube também inclui `metricasPeriodo`, que representa a atividade entre as datas solicitadas. Campos indisponíveis ficam como `null`; o script não estima alcance, visualizações ou retenção.

## Limites

- TikTok retorna apenas vídeos públicos do usuário que autorizou o aplicativo.
- Métricas de alcance/visualizações da Página Facebook dependem das permissões e da disponibilidade atual dos Insights; o relatório registra o que a API liberar.
- Algumas métricas podem atrasar, ser agregadas ou mudar de nome pelas plataformas. Confira o aviso da rede antes de comparar períodos.

Referências: [Meta Insights](https://developers.facebook.com/docs/insights/get-started), [TikTok scopes](https://developers.tiktok.com/docs/en/tiktok-api-scopes) e [YouTube Analytics](https://developers.google.com/youtube/analytics/channel_reports).
