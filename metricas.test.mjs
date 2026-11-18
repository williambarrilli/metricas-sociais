import assert from 'node:assert/strict';
import test from 'node:test';
import { coletarMetricas, criarPeriodo, paginarGet } from './metricas.mjs';

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
  const fetchImpl = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(respostas.get(url)) });
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
  assert.ok(!relatorio.plataformas.falha.erro.includes('segredo-nao-vaza'));
});

test('credenciais ausentes falham sem fazer chamadas HTTP', async () => {
  const relatorio = await coletarMetricas({
    env: {}, agora: new Date('2026-11-18T12:00:00Z'),
    fetchImpl: async () => { throw new Error('não deveria chamar a rede'); },
  });
  assert.equal(relatorio.parcial, true);
  for (const plataforma of Object.values(relatorio.plataformas)) {
    assert.equal(plataforma.status, 'erro');
    assert.match(plataforma.erro, /Configure no .env/);
  }
});
