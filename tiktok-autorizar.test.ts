import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { ESCOPOS, REDIRECT_URI, criarPkce, urlAutorizacao } from './tiktok-autorizar.js';

test('PKCE usa SHA-256 em hexadecimal, como pede o Login Kit Desktop', () => {
  const { verificador, desafio } = criarPkce();
  assert.match(verificador, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(desafio, crypto.createHash('sha256').update(verificador).digest('hex'));
});

test('link de autorização leva escopos, redirect e PKCE', () => {
  const url = new URL(urlAutorizacao('chave', 'desafio', 'estado'));
  assert.equal(url.origin + url.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.equal(url.searchParams.get('client_key'), 'chave');
  assert.equal(url.searchParams.get('scope'), ESCOPOS.join(','));
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'estado');
});
