/**
 * FNX DEV — Worker (Cloudflare)
 * --------------------------------------------------------------
 * Serve o site (pasta /public) e as rotas da API:
 *   POST /api/checkout        → valida o pré-cadastro e cria o pagamento na Stripe
 *   POST /api/personalizado   → pedido de orçamento (e-mail p/ vendas + cópia p/ cliente)
 *   POST /api/contato         → mensagem do formulário de contato
 *   POST /api/stripe-webhook  → Stripe avisa que pagou → e-mails com dados, registro do aceite e contrato em PDF
 *   POST /api/reembolso       → pedido de reembolso com protocolo (página reembolso.html)
 *   POST /api/aprovar         → cliente aprova a entrega e começa a garantia de 90 dias (página aprovar.html)
 *   POST /api/estornar        → tela segura de estorno (link enviado só para a equipe; página estornar.html)
 *   GET  /api/contrato-assinado → contrato assinado + certificado de assinatura
 *
 * Eventos do webhook na Stripe: checkout.session.completed, checkout.session.async_payment_succeeded,
 *   checkout.session.async_payment_failed, charge.refunded
 *
 * Variáveis (wrangler.jsonc → "vars"):
 *   SITE_URL, SALES_EMAIL, SUPPORT_EMAIL, RESEND_FROM, PAYMENT_METHODS_BRL
 * Segredos (Cloudflare → Worker → Settings → Variables and Secrets → tipo "Secret"):
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY
 *   TOKEN_SECRET (opcional, recomendado) → texto aleatório longo usado nos links de aprovação/contrato/estorno
 *
 * Idioma: e-mails para VOCÊ (vendas) são sempre em português.
 *         E-mails e mensagens para o CLIENTE seguem o idioma do site (pt/en).
 */

// ============ PREÇOS (em centavos) — a fonte da verdade do valor cobrado ============
// R$ 300 = 30000 | US$ 150 = 15000
const PLANOS = {
  landing:  { pt: 'Landing Page', en: 'Landing Page', brl: 30000,  usd: 15000 },
  starter:  { pt: 'Starter',      en: 'Starter',      brl: 60000,  usd: 35000 },
  business: { pt: 'Business',     en: 'Business',     brl: 100000, usd: 60000 },
  sistema:  { pt: 'Sistema Web',  en: 'Web System',   brl: 150000, usd: 100000 },
};

// ============ PAÍSES BLOQUEADOS (sanções / regras da Stripe) ============
// Edite aqui E no index.html (const BLOQUEADOS) se mudar a lista.
const BLOQUEADOS = {
  CU: 'Cuba', IR: 'Irã', KP: 'Coreia do Norte', SY: 'Síria', RU: 'Rússia', BY: 'Belarus',
  VE: 'Venezuela', MM: 'Mianmar', AF: 'Afeganistão', SD: 'Sudão', SS: 'Sudão do Sul',
  LY: 'Líbia', YE: 'Iêmen', SO: 'Somália', CF: 'República Centro-Africana', CD: 'República Democrática do Congo',
};

// ============ CONTRATO ============
// O contrato fica em PDF dentro do site (public/assets/contrato/).
// Mudou o texto? Gere um PDF novo com outro número de versão e troque aqui
// (os pedidos antigos continuam ligados à versão que o cliente aceitou).
const VERSAO_CONTRATO = '1.2';
// Cada versão: o PDF (para baixar) e o HTML (o texto exato que o cliente lê e assina no checkout).
// Não apague versões antigas: pedidos antigos continuam ligados à versão que foi assinada.
const CONTRATOS = {
  '1.2': {
    pdf: { pt: '/assets/contrato/contrato-fnx-dev-v1.2-pt.pdf', en: '/assets/contrato/contrato-fnx-dev-v1.2-en.pdf' },
    html: { pt: '/assets/contrato/contrato-fnx-dev-v1.2-pt.html', en: '/assets/contrato/contrato-fnx-dev-v1.2-en.html' },
  },
};
const CONTRATO_PDF = CONTRATOS[VERSAO_CONTRATO].pdf;
const VERSAO_POLITICAS = '2026-11-20';

// ============ PRAZO DE DESISTÊNCIA ============
// Brasil e demais países: 7 dias. Consumidores do Reino Unido, UE, Islândia, Liechtenstein e Noruega: 14 dias.
const PAISES_14_DIAS = new Set(['GB','AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO']);
function prazoDesistencia(pais) { return PAISES_14_DIAS.has(String(pais || '').toUpperCase()) ? 14 : 7; }
const DIAS_GARANTIA = 90;

// ============ TEXTOS PARA O CLIENTE ============
const MSG = {
  pt: {
    plano: 'Plano inválido.', obrig: 'Preencha todos os campos obrigatórios.', desc: 'Descreva rapidamente o projeto.',
    email: 'E-mail inválido.', pais: 'País inválido.', paisNao: 'Infelizmente não atendemos o país selecionado.',
    local: 'Infelizmente não atendemos a sua localização.', doc: 'CPF ou CNPJ inválido.',
    aceites: 'É preciso aceitar o contrato, os termos e as políticas.', privacidade: 'É preciso aceitar a Política de Privacidade.',
    interno: 'Erro interno. Tente novamente ou fale com a gente pelo WhatsApp.',
    assinatura: 'Para assinar, digite seu nome completo exatamente como no cadastro.',
  },
  en: {
    plano: 'Invalid plan.', obrig: 'Please fill in all required fields.', desc: 'Please briefly describe the project.',
    email: 'Invalid email.', pais: 'Invalid country.', paisNao: "Sorry, we don't serve the selected country.",
    local: "Sorry, we don't serve your location.", doc: 'Invalid CPF or CNPJ.',
    aceites: 'You must accept the agreement, terms and policies.', privacidade: 'You must accept the Privacy Policy.',
    interno: 'Internal error. Please try again or reach us on WhatsApp.',
    assinatura: 'To sign, type your full name exactly as entered in your details.',
  },
};

// =====================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/contrato-assinado' && request.method === 'GET') {
        try { return await rotaContratoAssinado(request, env); }
        catch (e) { console.error('Erro contrato assinado', e && e.stack || e); return new Response('Erro ao abrir o contrato.', { status: 500 }); }
      }
      if (request.method !== 'POST') return json({ ok: false, erro: 'Método não permitido' }, 405);
      try {
        switch (url.pathname) {
          case '/api/checkout': return await rotaCheckout(request, env);
          case '/api/personalizado': return await rotaPersonalizado(request, env);
          case '/api/contato': return await rotaContato(request, env);
          case '/api/stripe-webhook': return await rotaWebhook(request, env);
          case '/api/reembolso': return await rotaReembolso(request, env);
          case '/api/aprovar': return await rotaAprovar(request, env);
          case '/api/estornar': return await rotaEstornar(request, env);
        }
        return json({ ok: false, erro: 'Rota não encontrada' }, 404);
      } catch (e) {
        console.error('Erro na API', url.pathname, e && e.stack || e);
        const codigo = e instanceof StripeErro ? ` (código: stripe-${e.status}${e.codigo ? '-' + e.codigo : ''}${e.param ? ' / ' + e.param : ''} — ${e.message.replace(/^Stripe: /, '').slice(0, 220)})` : '';
        return json({ ok: false, erro: MSG.pt.interno + ' / ' + MSG.en.interno + codigo }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------------
// 1) CHECKOUT
// ---------------------------------------------------------------------
async function rotaCheckout(request, env) {
  const d = await lerJson(request);
  const L = idioma(d), m = MSG[L];
  if (d.website) return json({ ok: true, url: env.SITE_URL }); // robô (honeypot)

  const plano = PLANOS[d.plano];
  if (!plano) return erro(m.plano);

  const campos = { nome: 120, email: 160, telefone: 40, pais: 2, documento: 40, cidade: 120, endereco: 240 };
  for (const [k, max] of Object.entries(campos)) {
    d[k] = limpa(d[k], max);
    if (!d[k]) return erro(m.obrig);
  }
  d.empresa = limpa(d.empresa, 160);
  d.site = limpa(d.site, 200);
  d.descricao = limpa(d.descricao, 1400, true);
  if (!d.descricao) return erro(m.desc);
  if (!emailOk(d.email)) return erro(m.email);

  d.pais = d.pais.toUpperCase();
  if (!/^[A-Z]{2}$/.test(d.pais)) return erro(m.pais);
  if (BLOQUEADOS[d.pais]) return erro(m.paisNao);

  // Bloqueio também pelo país de onde vem a conexão (Cloudflare)
  const paisIp = (request.cf && request.cf.country) || '';
  if (BLOQUEADOS[paisIp]) return erro(m.local);

  if (d.pais === 'BR') {
    const doc = d.documento.replace(/\D/g, '');
    if (!cpfValido(doc) && !cnpjValido(doc)) return erro(m.doc);
  }

  const a = d.aceites || {};
  if (!(a.termos && a.privacidade && a.contrato && a.pais)) return erro(m.aceites);

  // Assinatura eletrônica: nome completo digitado, igual ao do cadastro
  const assinatura = limpa(d.assinatura, 120);
  if (!assinatura || normalizaNome(assinatura) !== normalizaNome(d.nome) || normalizaNome(assinatura).split(' ').length < 2) return erro(m.assinatura);
  // Código de integridade (SHA-256) do texto exato do contrato que o cliente leu e assinou
  const textoContrato = await lerContrato(env, request, VERSAO_CONTRATO, L);
  const hashContrato = await sha256hex(textoContrato);

  const moeda = d.pais === 'BR' ? 'brl' : 'usd';
  const valor = plano[moeda];
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const agora = new Date().toISOString();

  // Dados do cliente vão no "metadata" da Stripe (limite 500 caracteres por campo)
  const desc = d.descricao;
  const metadata = {
    plano: d.plano, plano_nome: plano.pt, nome: d.nome, email: d.email, telefone: d.telefone,
    documento: d.documento, pais: d.pais, cidade: d.cidade, endereco: d.endereco,
    empresa: d.empresa || '', site: d.site || '', idioma: L,
    desc_1: desc.slice(0, 480), desc_2: desc.slice(480, 960), desc_3: desc.slice(960, 1440),
    aceite_em: agora, aceite_ip: ip, aceite_pais_ip: paisIp, politicas_versao: VERSAO_POLITICAS,
    contrato_versao: VERSAO_CONTRATO, contrato_aceito: 'sim', janela_dias: String(prazoDesistencia(d.pais)),
    contrato_idioma: L, contrato_sha256: hashContrato, assinatura_nome: assinatura,
    // Reino Unido / UE: o cliente pode pedir para o serviço começar e ser entregue antes dos 14 dias (cláusula 4.11)
    inicio_antecipado: (PAISES_14_DIAS.has(d.pais) && a.antecipado) ? 'sim' : 'nao',
    user_agent: (request.headers.get('User-Agent') || '').slice(0, 300),
  };

  const nomeProduto = L === 'en' ? `FNX DEV — ${plano.en} plan` : `FNX DEV — Plano ${plano.pt}`;
  const params = {
    mode: 'payment',
    customer_email: d.email,
    client_reference_id: d.plano,
    billing_address_collection: 'required',
    locale: L === 'en' ? 'en' : 'pt-BR',
    success_url: `${env.SITE_URL}/sucesso.html?pedido={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.SITE_URL}/cancelado.html`,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: moeda,
        unit_amount: valor,
        product_data: { name: nomeProduto, description: L === 'en' ? 'Web development — one-time payment' : 'Desenvolvimento web — pagamento único' },
      },
    }],
    metadata,
    payment_intent_data: { metadata, description: `FNX DEV — Plano ${plano.pt} — ${d.nome}` },
  };

  if (moeda === 'brl') {
    const metodos = (env.PAYMENT_METHODS_BRL || 'card,boleto').split(',').map(s => s.trim()).filter(Boolean);
    params.payment_method_types = metodos;
    const opts = {};
    if (metodos.includes('card')) opts.card = { installments: { enabled: true } };
    if (metodos.includes('boleto')) opts.boleto = { expires_after_days: 3 };
    if (metodos.includes('pix')) opts.pix = { expires_after_seconds: 3600 };
    params.payment_method_options = opts;
  } else {
    params.payment_method_types = ['card'];
  }

  const sessao = await criarCheckout(env, params);

  // Aviso de pré-cadastro (lead) — chega mesmo se a pessoa desistir no pagamento
  await enviarEmail(env, {
    to: env.SALES_EMAIL,
    reply_to: d.email,
    subject: `Pré-cadastro: ${d.nome} — Plano ${plano.pt} (aguardando pagamento)`,
    html: layout('Novo pré-cadastro', `
      <p>Uma pessoa preencheu o pré-cadastro e foi para o pagamento. <b>Ainda não pagou.</b>
      Se o pagamento for concluído, você recebe outro e-mail com o contrato.</p>
      ${tabelaCliente(d, plano.pt, moneyFmt(valor, moeda))}
      <p style="color:#888;font-size:12px">Idioma do cliente: ${L === 'en' ? 'inglês' : 'português'} · Sessão Stripe: ${esc(sessao.id)}</p>`),
    idempotencia: `lead-${sessao.id}`,
  }).catch(e => console.error('Falha e-mail lead', e));

  return json({ ok: true, url: sessao.url });
}

// ---------------------------------------------------------------------
// 2) PLANO PERSONALIZADO
// ---------------------------------------------------------------------
async function rotaPersonalizado(request, env) {
  const d = await lerJson(request);
  const L = idioma(d), m = MSG[L];
  if (d.website) return json({ ok: true });
  d.nome = limpa(d.nome, 120); d.email = limpa(d.email, 160); d.telefone = limpa(d.telefone, 40);
  d.tipo = limpa(d.tipo, 80); d.descricao = limpa(d.descricao, 2000, true);
  if (!d.nome || !emailOk(d.email) || !d.telefone || !d.tipo || !d.descricao) return erro(m.obrig);
  if (!d.aceite) return erro(m.privacidade);
  const pais = limpa(d.pais, 2).toUpperCase();
  if (BLOQUEADOS[pais] || BLOQUEADOS[(request.cf && request.cf.country) || '']) return erro(m.local);

  const recursos = Array.isArray(d.recursos) ? d.recursos.map(r => limpa(r, 80)).filter(Boolean).slice(0, 30) : [];
  const linhas = [
    ['Nome', d.nome], ['E-mail', d.email], ['WhatsApp', d.telefone], ['País', pais],
    ['Empresa', limpa(d.empresa, 160)], ['Site/referência', limpa(d.referencia, 200)],
    ['Tipo de projeto', d.tipo], ['Funcionalidades', recursos.join(', ')],
    ['Páginas/telas', limpa(d.paginas, 40)], ['Prazo', limpa(d.prazo, 60)], ['Investimento', limpa(d.orcamento, 60)],
    ['Idioma do cliente', L === 'en' ? 'Inglês' : 'Português'],
  ];
  const corpo = `${tabela(linhas)}<h3 style="margin:20px 0 8px">Sobre o projeto</h3><p style="white-space:pre-wrap">${esc(d.descricao)}</p>`;

  await enviarEmail(env, {
    to: env.SALES_EMAIL, reply_to: d.email,
    subject: `Orçamento personalizado: ${d.nome} — ${d.tipo}`,
    html: layout('Novo pedido de orçamento', corpo + `<p><a href="${waLink(d.telefone)}">Responder no WhatsApp</a></p>`),
  });

  const primeiro = esc(d.nome.split(' ')[0]);
  const resumoCliente = `<p style="white-space:pre-wrap;background:#fafafa;border-radius:8px;padding:12px">${esc(d.descricao)}</p>`;
  await enviarEmail(env, {
    to: d.email, reply_to: env.SALES_EMAIL,
    subject: L === 'en' ? 'We received your quote request — FNX DEV' : 'Recebemos seu pedido de orçamento — FNX DEV',
    html: L === 'en'
      ? layout('Request received!', `<p>Hi ${primeiro}! We received your request and will reply within 1 business day.</p><p>What you told us about the project:</p>${resumoCliente}`)
      : layout('Pedido recebido!', `<p>Olá, ${primeiro}! Recebemos o seu pedido e respondemos em até 1 dia útil.</p><p>Este é o resumo do que você enviou:</p>${corpo}`),
  }).catch(e => console.error('Falha cópia cliente', e));

  return json({ ok: true });
}

// ---------------------------------------------------------------------
// 3) CONTATO
// ---------------------------------------------------------------------
async function rotaContato(request, env) {
  const d = await lerJson(request);
  const L = idioma(d), m = MSG[L];
  if (d.website) return json({ ok: true });
  d.nome = limpa(d.nome, 120); d.email = limpa(d.email, 160); d.mensagem = limpa(d.mensagem, 2000, true);
  if (!d.nome || !emailOk(d.email) || !d.mensagem) return erro(m.obrig);
  if (!d.aceite) return erro(m.privacidade);
  const assunto = limpa(d.assunto, 80) || 'Contato';
  const ehReembolso = /reembolso|cancelamento/i.test(assunto);
  const ehPrivacidade = /privacidade|lgpd/i.test(assunto);
  const destino = (/suporte/i.test(assunto) || ehReembolso || ehPrivacidade) ? (env.SUPPORT_EMAIL || env.SALES_EMAIL) : env.SALES_EMAIL;
  const recebidoEm = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  let aviso = '';
  if (ehReembolso) aviso = `<p style="background:#fff7f0;border-left:3px solid #ff6a00;padding:10px 12px;border-radius:0 8px 8px 0"><b>Pedido de reembolso/cancelamento.</b> Confira se está dentro dos 7 dias da compra. Se estiver, faça o estorno na Stripe <b>imediatamente</b> (Payments → pagamento → Refund) e não entregue nada do projeto. O cliente já recebeu a confirmação automática de recebimento.</p>`;
  if (ehPrivacidade) aviso = `<p style="background:#fff7f0;border-left:3px solid #ff6a00;padding:10px 12px;border-radius:0 8px 8px 0"><b>Pedido sobre dados pessoais (LGPD).</b> Prazo para responder: até 15 dias a partir de ${esc(recebidoEm)}. O cliente já recebeu a confirmação automática de recebimento.</p>`;

  await enviarEmail(env, {
    to: destino, reply_to: d.email,
    subject: `[Site] ${assunto} — ${d.nome}`,
    html: layout('Nova mensagem pelo site', aviso + tabela([['Nome', d.nome], ['E-mail', d.email], ['WhatsApp', limpa(d.telefone, 40)], ['Assunto', assunto], ['Recebido em', recebidoEm], ['Idioma', L === 'en' ? 'Inglês' : 'Português']])
      + `<p style="white-space:pre-wrap;margin-top:16px">${esc(d.mensagem)}</p>`),
  });

  // Confirmação automática para o cliente (pedido de cancelamento/reembolso e pedidos de dados — Decreto 7.962/2013 e LGPD)
  if (ehReembolso || ehPrivacidade) {
    const primeiro = esc(d.nome.split(' ')[0]);
    const html = L === 'en'
      ? layout('We received your request', `<p>Hi ${primeiro}! This confirms we received your ${ehReembolso ? 'cancellation/refund' : 'personal data'} request on ${esc(recebidoEm)} (Brasília time).</p>
          <p>${ehReembolso ? "If it is within 7 days of your purchase, we will request the full refund from Stripe right away and email you once it is processed." : "We will reply within 15 days."}</p>
          <p style="white-space:pre-wrap;background:#fafafa;border-radius:8px;padding:12px">${esc(d.mensagem)}</p>`)
      : layout('Recebemos o seu pedido', `<p>Olá, ${primeiro}! Confirmamos que recebemos o seu pedido de ${ehReembolso ? 'cancelamento/reembolso' : 'informação sobre dados pessoais (LGPD)'} em ${esc(recebidoEm)}.</p>
          <p>${ehReembolso ? 'Se estiver dentro dos 7 dias da compra, pedimos o estorno integral à Stripe imediatamente e avisamos você por e-mail quando for processado.' : 'Respondemos em até 15 dias.'}</p>
          <p style="white-space:pre-wrap;background:#fafafa;border-radius:8px;padding:12px">${esc(d.mensagem)}</p>`);
    await enviarEmail(env, {
      to: d.email, reply_to: env.SUPPORT_EMAIL || env.SALES_EMAIL,
      subject: L === 'en' ? 'We received your request — FNX DEV' : 'Recebemos o seu pedido — FNX DEV',
      html,
    }).catch(e => console.error('Falha confirmação cliente', e));
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------------
// 4) WEBHOOK DA STRIPE
// ---------------------------------------------------------------------
async function rotaWebhook(request, env) {
  const corpo = await request.text();
  const valido = await assinaturaStripeOk(corpo, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET);
  if (!valido) return new Response('assinatura inválida', { status: 400 });

  const evento = JSON.parse(corpo);
  const s = evento.data && evento.data.object;

  switch (evento.type) {
    case 'checkout.session.completed':
      if (s.payment_status === 'paid') await pagamentoConfirmado(env, s.id);
      else await avisoPendente(env, s); // boleto/pix gerado, aguardando pagamento
      break;
    case 'checkout.session.async_payment_succeeded':
      await pagamentoConfirmado(env, s.id);
      break;
    case 'charge.refunded':
      await estornoNaStripe(env, s);
      break;
    case 'checkout.session.async_payment_failed': {
      const m = s.metadata || {};
      await enviarEmail(env, {
        to: env.SALES_EMAIL,
        subject: `Pagamento NÃO concluído: ${m.nome || ''} — ${m.plano_nome || ''}`,
        html: layout('Boleto/Pix expirou sem pagamento', tabelaCliente(metaParaCliente(m), m.plano_nome, moneyFmt(s.amount_total, s.currency))),
        idempotencia: `falhou-${s.id}`,
      });
      break;
    }
  }
  return new Response('ok');
}

async function avisoPendente(env, s) {
  const m = s.metadata || {};
  await enviarEmail(env, {
    to: env.SALES_EMAIL,
    subject: `Aguardando pagamento (boleto/Pix): ${m.nome || ''} — ${m.plano_nome || ''}`,
    html: layout('Boleto ou Pix gerado', `<p>O cliente gerou o boleto/Pix. Você recebe o e-mail com o contrato quando o pagamento for confirmado.</p>
      ${tabelaCliente(metaParaCliente(m), m.plano_nome, moneyFmt(s.amount_total, s.currency))}`),
    idempotencia: `pendente-${s.id}`,
  });
}

async function pagamentoConfirmado(env, sessionId) {
  const s = await stripe(env, 'GET', `/v1/checkout/sessions/${sessionId}?expand[]=payment_intent.latest_charge`);
  const m = s.metadata || {};
  const L = m.idioma === 'en' ? 'en' : 'pt';
  const cliente = metaParaCliente(m);
  const valor = moneyFmt(s.amount_total, s.currency);
  const pedido = s.id.slice(-10).toUpperCase();
  const planoInfo = PLANOS[m.plano] || { pt: m.plano_nome, en: m.plano_nome };

  // Checagem final do país: endereço de cobrança e país do cartão
  const paisCobranca = s.customer_details && s.customer_details.address && s.customer_details.address.country;
  const charge = s.payment_intent && s.payment_intent.latest_charge;
  const paisCartao = charge && charge.payment_method_details && charge.payment_method_details.card && charge.payment_method_details.card.country;
  const bloqueio = [m.pais, paisCobranca, paisCartao, m.aceite_pais_ip].find(c => c && BLOQUEADOS[c]);

  if (bloqueio) {
    await stripe(env, 'POST', '/v1/refunds', {
      payment_intent: s.payment_intent.id, reason: 'requested_by_customer',
      metadata: { motivo: `pais_bloqueado_${bloqueio}` },
    }).catch(e => console.error('Falha ao estornar', e));
    await enviarEmail(env, {
      to: env.SALES_EMAIL,
      subject: `⚠️ Compra estornada automaticamente (país bloqueado: ${BLOQUEADOS[bloqueio]})`,
      html: layout('Compra bloqueada e estornada', `<p>O pagamento abaixo foi estornado porque envolve país/região não atendida (<b>${esc(BLOQUEADOS[bloqueio])}</b>). Não preste o serviço.</p>
        ${tabelaCliente(cliente, m.plano_nome, valor)}
        ${tabela([['País informado', m.pais], ['País da cobrança', paisCobranca], ['País do cartão', paisCartao], ['País do IP', m.aceite_pais_ip]])}`),
      idempotencia: `bloqueado-${s.id}`,
    });
    return;
  }

  const hoje = new Date();
  const dataBR = hoje.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const janela = Number(m.janela_dias) || prazoDesistencia(m.pais);
  const fimPrazo = new Date(hoje.getTime() + janela * 24 * 3600 * 1000);
  const fimBR = fimPrazo.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const fimEN = fimPrazo.toLocaleDateString('en-GB', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: 'long', day: 'numeric' });
  const dataEN = hoje.toLocaleDateString('en-GB', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: 'long', day: 'numeric' });
  const linkAprovacao = await linkDeAprovacao(env, s.id);
  const assinado = await montarContratoAssinado(env, s, null);
  const linkAssinado = `${env.SITE_URL}/api/contrato-assinado?pedido=${encodeURIComponent(s.id)}&t=${await tokenAssinado(env, s.id)}`;
  const anexoAssinado = { filename: `${L === 'en' ? 'Signed-Agreement' : 'Contrato-assinado'}-FNX-DEV-${pedido}.html`, content: base64Utf8(assinado.html) };

  // E-mail para você (vendas): dados + pedido + registro do aceite + link de aprovação
  await enviarEmail(env, {
    to: env.SALES_EMAIL,
    reply_to: cliente.email,
    subject: `💰 Nova venda: Plano ${planoInfo.pt} — ${cliente.nome} (${valor})`,
    anexos: [anexoAssinado],
    html: layout('Nova compra confirmada', `
      <p><b>Pagamento confirmado.</b> Entre em contato com o cliente em até 1 dia útil.</p>
      ${m.inicio_antecipado === 'sim'
        ? `<p style="background:#ecfdf5;border-left:3px solid #16a34a;padding:10px 12px;border-radius:0 8px 8px 0"><b>Cliente pediu início antecipado (Reino Unido/UE).</b> Você pode começar e entregar antes de ${fimBR}. Se ele desistir até essa data, o reembolso é <b>proporcional</b> ao que já foi feito; depois de entregar tudo, ele perde o direito de desistência.</p>`
        : `<p style="background:#fff7f0;border-left:3px solid #ff6a00;padding:10px 12px;border-radius:0 8px 8px 0"><b>Prazo de desistência de ${janela} dias: até ${fimBR}.</b> Pode fazer briefing e prévias, mas só publique / entregue arquivos e acessos depois dessa data.</p>`}
      <h3 style="margin:18px 0 8px">Pedido</h3>
      ${tabela([['Pedido', pedido], ['Plano', planoInfo.pt], ['Valor', valor], ['Forma de pagamento', (charge && charge.payment_method_details && charge.payment_method_details.type) || (s.payment_method_types || []).join(', ')], ['Data', dataBR], [`Fim do prazo de desistência (${janela} dias)`, fimBR], ['Idioma do cliente', L === 'en' ? 'Inglês' : 'Português']])}
      <h3 style="margin:18px 0 8px">Cliente</h3>
      ${tabelaCliente(cliente)}
      <h3 style="margin:18px 0 8px">Contrato assinado</h3>
      ${tabela([['Assinado por', m.assinatura_nome], ['Documento', cliente.documento], ['Assinado em', assinado.dataBR + ' (Brasília)'], ['IP / país', `${m.aceite_ip || ''} / ${m.aceite_pais_ip || ''}`], ['Contrato', `versão ${m.contrato_versao} (${m.contrato_idioma === 'en' ? 'inglês' : 'português'})`], ['Integridade do texto (SHA-256)', assinado.integro ? 'Confere com o texto assinado ✔' : 'ATENÇÃO: não confere'], ['Início antecipado (UK/UE)', m.inicio_antecipado === 'sim' ? 'Sim — pedido expresso registrado' : '']])}
      <p>O contrato assinado com o certificado está <b>anexado</b> a este e-mail. Também dá para abrir e salvar em PDF por aqui: <a href="${linkAssinado}">ver contrato assinado</a>.</p>
      <h3 style="margin:18px 0 8px">Quando entregar o projeto</h3>
      <p>Envie este link ao cliente. Quando ele aprovar, a <b>garantia de ${DIAS_GARANTIA} dias</b> começa e você recebe um e-mail com a data final. Se ele não responder em 7 dias, o contrato considera a entrega aprovada.</p>
      <p style="word-break:break-all;background:#fafafa;border-radius:8px;padding:10px 12px;font-size:13px"><a href="${linkAprovacao}">${linkAprovacao}</a></p>
      <p style="margin-top:18px"><a href="${waLink(cliente.telefone)}">Chamar cliente no WhatsApp</a> · <a href="https://dashboard.stripe.com/payments/${esc(s.payment_intent && s.payment_intent.id || '')}">Ver na Stripe</a></p>`),
    idempotencia: `venda-${s.id}`,
  });

  // E-mail para o cliente (no idioma dele), com o contrato em PDF anexado
  const primeiro = esc(cliente.nome.split(' ')[0]);
  const suporte = esc(env.SUPPORT_EMAIL || env.SALES_EMAIL);
  const html = L === 'en'
    ? layout('Payment confirmed!', `
      <p>Hi ${primeiro}! Thank you for choosing FNX DEV.</p>
      <p>We received your payment for the <b>${esc(planoInfo.en)} plan</b> (${esc(valor)}). We'll contact you by WhatsApp or email within <b>1 business day</b> to go over the briefing.</p>
      ${tabela([['Order', pedido], ['Plan', planoInfo.en], ['Amount', valor], ['Date', dataEN]])}
      <h3 style="margin:18px 0 8px">Your signed agreement</h3>
      ${tabela([['Signed by', m.assinatura_nome], ['Signed on', assinado.dataEN + ' (Brasília time)'], ['Agreement', `Services Agreement, version ${m.contrato_versao}`]])}
      <p>The signed agreement with its signature certificate is <b>attached</b> to this email. You can also <a href="${linkAssinado}">open it here</a> and save it as PDF.</p>
      <p style="margin-top:18px;font-size:13px;color:#666"><b>${janela}-day guarantee:</b> if you change your mind by ${esc(fimEN)}, use <a href="${env.SITE_URL}/reembolso.html">Request a refund</a>, reply to this email or write to ${suporte}, and ${m.inicio_antecipado === 'sim' ? "we'll refund the amount paid minus the work already done (you asked us to start early; the right to cancel ends once the service is fully delivered)." : "we'll refund 100%. Launch and handover happen after that date."} After delivery, bugs in the work we built are fixed free of charge for ${DIAS_GARANTIA} days.
      Policies: <a href="${env.SITE_URL}/policies.html">${env.SITE_URL}/policies.html</a></p>`)
    : layout('Pagamento confirmado!', `
      <p>Olá, ${primeiro}! Obrigado por escolher a FNX DEV.</p>
      <p>Recebemos o pagamento do <b>Plano ${esc(planoInfo.pt)}</b> (${esc(valor)}). Vamos entrar em contato pelo WhatsApp ou e-mail em até <b>1 dia útil</b> para alinhar o briefing.</p>
      ${tabela([['Pedido', pedido], ['Plano', planoInfo.pt], ['Valor', valor], ['Data', dataBR]])}
      <h3 style="margin:18px 0 8px">Seu contrato assinado</h3>
      ${tabela([['Assinado por', m.assinatura_nome], ['Assinado em', assinado.dataBR + ' (Brasília)'], ['Contrato', `Contrato de Prestação de Serviços, versão ${m.contrato_versao}`]])}
      <p>O contrato assinado, com o certificado de assinatura, está <b>anexado</b> a este e-mail. Você também pode <a href="${linkAssinado}">abrir aqui</a> e salvar em PDF.</p>
      <p style="margin-top:18px;font-size:13px;color:#666"><b>Garantia de ${janela} dias:</b> se desistir até ${fimBR}, use a página <a href="${env.SITE_URL}/reembolso.html">Solicitar reembolso</a>, responda este e-mail ou escreva para ${suporte}, e ${m.inicio_antecipado === 'sim' ? 'devolvemos o valor pago menos o trabalho já feito (você pediu início antecipado; o direito termina quando o serviço for entregue por completo).' : 'devolvemos 100% do valor. A publicação e a entrega acontecem depois dessa data.'} Depois da entrega, erros e bugs do que desenvolvemos são corrigidos sem custo por ${DIAS_GARANTIA} dias.
      Políticas: <a href="${env.SITE_URL}/politicas.html">${env.SITE_URL}/politicas.html</a></p>`);

  await enviarEmail(env, {
    to: cliente.email,
    reply_to: env.SALES_EMAIL,
    subject: L === 'en' ? `Payment confirmed — ${planoInfo.en} plan | FNX DEV` : `Pagamento confirmado — Plano ${planoInfo.pt} | FNX DEV`,
    html,
    anexos: [anexoAssinado],
    idempotencia: `cliente-${s.id}`,
  });
}

// ---------------------------------------------------------------------
// 5) PEDIDO DE REEMBOLSO (página "Solicitar reembolso")
// ---------------------------------------------------------------------
async function rotaReembolso(request, env) {
  const d = await lerJson(request);
  const L = idioma(d), m = MSG[L];
  if (d.website) return json({ ok: true, protocolo: '' });
  const email = limpa(d.email, 160), pedidoInf = limpa(d.pedido, 80), motivo = limpa(d.motivo, 1500, true), nome = limpa(d.nome, 120);
  if (!nome || !emailOk(email) || !pedidoInf) return erro(m.obrig);

  const agora = new Date();
  const recebidoEm = agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const recebidoEmEN = agora.toLocaleString('en-GB', { timeZone: 'America/Sao_Paulo' });
  const protocolo = 'RB-' + agora.toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
  const pedidoNorm = pedidoInf.replace(/[^a-zA-Z0-9_]/g, '').toUpperCase();

  // Procura o pedido na Stripe pelo e-mail da compra
  let sessao = null, situacao = 'NÃO LOCALIZADO AUTOMATICAMENTE — confira na Stripe pelo e-mail do cliente';
  try {
    const lista = await stripe(env, 'GET', `/v1/checkout/sessions?limit=100&customer_details[email]=${encodeURIComponent(email)}`);
    sessao = (lista.data || []).find(x => x.payment_status === 'paid' &&
      (x.id.toUpperCase() === pedidoNorm || x.id.slice(-10).toUpperCase() === pedidoNorm.slice(-10))) || null;
  } catch (e) { console.error('Busca do pedido para reembolso falhou', e && e.message); }

  let dentro = null, prazo = '';
  if (sessao) {
    const mm = sessao.metadata || {};
    const janela = Number(mm.janela_dias) || prazoDesistencia(mm.pais);
    const fim = new Date(sessao.created * 1000 + janela * 24 * 3600 * 1000);
    dentro = agora <= fim;
    prazo = fim.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const antecipado = mm.inicio_antecipado === 'sim';
    situacao = !dentro ? `FORA DO PRAZO de ${janela} dias (terminou em ${prazo}) — analisar pelo contrato`
      : antecipado ? `DENTRO DO PRAZO (${janela} dias, até ${prazo}) com INÍCIO ANTECIPADO — reembolso PROPORCIONAL ao que já foi feito (cláusula 4.11). Se o serviço já foi totalmente entregue, o direito terminou.`
      : `DENTRO DO PRAZO (${janela} dias, até ${prazo}) — faça o estorno integral na Stripe AGORA`;
    if (sessao.payment_intent) {
      await stripe(env, 'POST', `/v1/payment_intents/${sessao.payment_intent}`, {
        metadata: { reembolso_protocolo: protocolo, reembolso_solicitado_em: agora.toISOString() },
      }).catch(e => console.error('Falha ao registrar reembolso na Stripe', e && e.message));
    }
  }

  const integral = dentro && !(sessao && (sessao.metadata || {}).inicio_antecipado === 'sim');
  const linkEstorno = sessao ? `${env.SITE_URL}/estornar.html?pedido=${encodeURIComponent(sessao.id)}&t=${await tokenHmac(env, 'estornar', sessao.id)}&p=${encodeURIComponent(protocolo)}` : '';
  const valorTxt = sessao ? moneyFmt(sessao.amount_total, sessao.currency) : '';
  const assunto = !sessao ? `⚠️ Pedido de reembolso (pedido NÃO localizado) — ${protocolo} — ${nome}`
    : integral ? `🔴 FAZER ESTORNO — ${valorTxt} — ${nome} — ${protocolo}`
    : dentro ? `🟠 ESTORNO PROPORCIONAL — ${nome} — ${protocolo}`
    : `Pedido de reembolso fora do prazo — ${nome} — ${protocolo}`;
  const botao = (href, texto, cor) => `<p style="margin:18px 0"><a href="${esc(href)}" style="display:inline-block;background:${cor};color:#fff;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:10px">${texto}</a></p>`;
  const htmlEquipe = layout(integral ? 'Ação necessária: fazer o estorno' : 'Pedido de reembolso / cancelamento', `
      <p style="background:${dentro ? '#fee2e2' : '#fff7f0'};border-left:3px solid ${dentro ? '#dc2626' : '#ff6a00'};padding:10px 12px;border-radius:0 8px 8px 0"><b>${esc(situacao)}</b></p>
      ${integral ? `<p>O cliente está dentro do prazo legal de desistência. O estorno integral deve ser feito <b>imediatamente</b> (CDC art. 49 / Decreto 7.962/2013).</p>` : ''}
      ${sessao ? botao(linkEstorno, integral ? 'Fazer o estorno agora' : 'Abrir a tela de estorno', '#dc2626') : ''}
      ${tabela([['Protocolo', protocolo], ['Recebido em', recebidoEm], ['Nome', nome], ['E-mail da compra', email], ['Pedido informado', pedidoInf], ['Pedido na Stripe', sessao ? sessao.id : '—'], ['Valor', valorTxt || '—'], ['Plano', sessao ? (sessao.metadata || {}).plano_nome : '—']])}
      ${motivo ? `<p style="white-space:pre-wrap;background:#fafafa;border-radius:8px;padding:12px;margin-top:12px">${esc(motivo)}</p>` : ''}
      ${sessao && sessao.payment_intent ? `<p style="font-size:13px">Também pode estornar pela Stripe: <a href="https://dashboard.stripe.com/payments/${esc(sessao.payment_intent)}">abrir o pagamento</a> → botão "Reembolsar".</p>` : `<p>Procure o pagamento na Stripe pelo e-mail <b>${esc(email)}</b> e faça o estorno pelo botão "Reembolsar".</p>`}
      <p style="font-size:12px;color:#888">O cliente já recebeu a confirmação com este protocolo. Quando o estorno for feito, ele recebe outro e-mail automaticamente.</p>`);
  const equipe = [...new Set([env.SALES_EMAIL, env.SUPPORT_EMAIL].filter(Boolean))];
  let avisados = 0;
  for (const destino of equipe) {
    await enviarEmail(env, { to: destino, reply_to: email, subject: assunto, html: htmlEquipe, idempotencia: `reembolso-${protocolo}-${destino}` })
      .then(() => avisados++).catch(e => console.error('Falha aviso de reembolso para', destino, e && e.message));
  }
  if (!avisados) console.error('NENHUM aviso de reembolso foi enviado', protocolo, email);

  const primeiro = esc(nome.split(' ')[0]);
  await enviarEmail(env, {
    to: email, reply_to: env.SUPPORT_EMAIL || env.SALES_EMAIL,
    subject: L === 'en' ? `Refund request received — ${protocolo} | FNX DEV` : `Recebemos seu pedido de reembolso — ${protocolo} | FNX DEV`,
    html: L === 'en'
      ? layout('Refund request received', `<p>Hi ${primeiro}! This confirms we received your cancellation/refund request.</p>
          ${tabela([['Reference', protocolo], ['Received on', recebidoEmEN + ' (Brasília time)'], ['Order', pedidoInf]])}
          <p>If the request is within your cancellation period, we refund you right away and you receive another email as soon as the refund is processed. Otherwise we will reply within 5 days.</p>`)
      : layout('Recebemos seu pedido de reembolso', `<p>Olá, ${primeiro}! Confirmamos o recebimento do seu pedido de cancelamento/reembolso.</p>
          ${tabela([['Protocolo', protocolo], ['Recebido em', recebidoEm], ['Pedido', pedidoInf]])}
          <p>Se o pedido estiver dentro do seu prazo de desistência, fazemos o estorno imediatamente e você recebe outro e-mail assim que ele for processado. Caso contrário, respondemos em até 5 dias.</p>`),
  }).catch(e => console.error('Falha confirmação reembolso', e));

  return json({ ok: true, protocolo, recebidoEm: L === 'en' ? recebidoEmEN : recebidoEm });
}

// ---------------------------------------------------------------------
// 6) APROVAÇÃO DA ENTREGA (inicia a garantia de 90 dias)
// ---------------------------------------------------------------------
// Chave dos links assinados (aprovação, contrato assinado, estorno).
// Use o secret TOKEN_SECRET (texto aleatório próprio) para os links não dependerem
// do segredo do webhook: se um dia trocar o webhook, os links antigos continuam valendo.
async function tokenHmac(env, finalidade, sessionId) {
  const segredo = env.TOKEN_SECRET || env.STRIPE_WEBHOOK_SECRET || env.STRIPE_SECRET_KEY || '';
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(finalidade + ':' + sessionId));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
async function tokenAprovacao(env, sessionId) { return tokenHmac(env, 'aprovar', sessionId); }
async function linkDeAprovacao(env, sessionId) {
  return `${env.SITE_URL}/aprovar.html?pedido=${encodeURIComponent(sessionId)}&t=${await tokenAprovacao(env, sessionId)}`;
}

async function rotaAprovar(request, env) {
  const d = await lerJson(request);
  const L = idioma(d);
  const id = limpa(d.pedido, 120), t = limpa(d.t, 64);
  const invalido = L === 'en' ? 'Invalid or expired approval link. Please contact us.' : 'Link de aprovação inválido. Fale com a gente.';
  if (!/^cs_[A-Za-z0-9_]+$/.test(id) || !t || !igualSeguro(t, await tokenAprovacao(env, id))) return erro(invalido);

  const s = await stripe(env, 'GET', `/v1/checkout/sessions/${id}?expand[]=payment_intent`);
  if (s.payment_status !== 'paid' || !s.payment_intent) return erro(invalido);
  const pi = s.payment_intent, mpi = pi.metadata || {}, m = s.metadata || {};
  const fmt = iso => new Date(iso).toLocaleDateString(L === 'en' ? 'en-GB' : 'pt-BR', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: L === 'en' ? 'long' : '2-digit', day: '2-digit' });
  const planoInfo = PLANOS[m.plano] || { pt: m.plano_nome, en: m.plano_nome };

  if (mpi.entrega_aprovada_em) {
    return json({ ok: true, jaAprovado: true, aprovadoEm: fmt(mpi.entrega_aprovada_em), garantiaAte: fmt(mpi.garantia_ate), plano: planoInfo[L] });
  }
  if (!d.confirmar) return json({ ok: true, jaAprovado: false, plano: planoInfo[L], nome: (m.nome || '').split(' ')[0] });

  const agora = new Date();
  const ate = new Date(agora.getTime() + DIAS_GARANTIA * 24 * 3600 * 1000);
  await stripe(env, 'POST', `/v1/payment_intents/${pi.id}`, {
    metadata: { entrega_aprovada_em: agora.toISOString(), garantia_ate: ate.toISOString(), aprovacao_ip: request.headers.get('CF-Connecting-IP') || '' },
  });
  const pedido = s.id.slice(-10).toUpperCase();
  const ateBR = ate.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  await enviarEmail(env, {
    to: env.SALES_EMAIL,
    subject: `✅ Entrega aprovada — ${m.nome || ''} — garantia até ${ateBR}`,
    html: layout('Entrega aprovada pelo cliente', tabela([['Pedido', pedido], ['Cliente', m.nome], ['Plano', planoInfo.pt], ['Aprovado em', agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })], [`Garantia de ${DIAS_GARANTIA} dias até`, ateBR], ['IP', request.headers.get('CF-Connecting-IP') || '']])),
    idempotencia: `aprovado-${s.id}`,
  }).catch(e => console.error('Falha e-mail aprovação vendas', e));
  if (m.email) {
    await enviarEmail(env, {
      to: m.email, reply_to: env.SUPPORT_EMAIL || env.SALES_EMAIL,
      subject: L === 'en' ? `Delivery approved — warranty until ${fmt(ate.toISOString())} | FNX DEV` : `Entrega aprovada — garantia até ${ateBR} | FNX DEV`,
      html: L === 'en'
        ? layout('Delivery approved', `<p>Thank you! Your approval was recorded.</p>${tabela([['Order', pedido], ['Plan', planoInfo.en], [`${DIAS_GARANTIA}-day bug warranty until`, fmt(ate.toISOString())]])}<p>If you find a bug in the work we built, email ${esc(env.SUPPORT_EMAIL || env.SALES_EMAIL)} with the order number and a description.</p>`)
        : layout('Entrega aprovada', `<p>Obrigado! Sua aprovação foi registrada.</p>${tabela([['Pedido', pedido], ['Plano', planoInfo.pt], [`Garantia de ${DIAS_GARANTIA} dias contra bugs até`, ateBR]])}<p>Se encontrar algum erro no que desenvolvemos, escreva para ${esc(env.SUPPORT_EMAIL || env.SALES_EMAIL)} com o número do pedido e a descrição.</p>`),
      idempotencia: `aprovado-cliente-${s.id}`,
    }).catch(e => console.error('Falha e-mail aprovação cliente', e));
  }
  return json({ ok: true, jaAprovado: false, aprovadoAgora: true, aprovadoEm: fmt(agora.toISOString()), garantiaAte: fmt(ate.toISOString()), plano: planoInfo[L] });
}

// ---------------------------------------------------------------------
// 6b) ESTORNO (tela segura enviada só para a equipe no e-mail de reembolso)
// ---------------------------------------------------------------------
async function rotaEstornar(request, env) {
  const d = await lerJson(request);
  const id = limpa(d.pedido, 120), t = limpa(d.t, 64), protocolo = limpa(d.protocolo, 40);
  if (!/^cs_[A-Za-z0-9_]+$/.test(id) || !t || !igualSeguro(t, await tokenHmac(env, 'estornar', id))) return erro('Link de estorno inválido.');

  const s = await stripe(env, 'GET', `/v1/checkout/sessions/${id}?expand[]=payment_intent.latest_charge`);
  if (s.payment_status !== 'paid' || !s.payment_intent) return erro('Este pedido não tem pagamento confirmado.');
  const m = s.metadata || {}, pi = s.payment_intent, charge = pi.latest_charge || {};
  const jaEstornado = Number(charge.amount_refunded || 0);
  const restante = s.amount_total - jaEstornado;
  const janela = Number(m.janela_dias) || prazoDesistencia(m.pais);
  const fim = new Date(s.created * 1000 + janela * 24 * 3600 * 1000);
  const info = {
    nome: m.nome || '', email: m.email || (s.customer_details || {}).email || '', plano: m.plano_nome || m.plano || '',
    pedido: s.id.slice(-10).toUpperCase(), moeda: s.currency, total: s.amount_total, jaEstornado, restante,
    totalTxt: moneyFmt(s.amount_total, s.currency), jaEstornadoTxt: moneyFmt(jaEstornado, s.currency), restanteTxt: moneyFmt(restante, s.currency),
    compra: new Date(s.created * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    fimPrazo: fim.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }), janela, dentro: new Date() <= fim,
    antecipado: m.inicio_antecipado === 'sim', protocolo: protocolo || (pi.metadata || {}).reembolso_protocolo || '',
  };
  if (restante <= 0) return json({ ok: true, ...info, estornadoTotal: true });
  if (!d.confirmar) return json({ ok: true, ...info });

  let valor = restante;
  if (d.valor != null && d.valor !== '') {
    valor = Math.round(Number(String(d.valor).replace(/\./g, '').replace(',', '.')) * 100);
    if (!Number.isFinite(valor) || valor <= 0 || valor > restante) return erro(`Valor inválido. Máximo: ${info.restanteTxt}.`);
  }
  const reembolso = await stripe(env, 'POST', '/v1/refunds', {
    payment_intent: pi.id, amount: valor, reason: 'requested_by_customer',
    metadata: { protocolo: info.protocolo, origem: 'tela_estorno', ip: request.headers.get('CF-Connecting-IP') || '' },
  }, `estorno-${pi.id}-${jaEstornado}-${valor}`);
  await avisarEstorno(env, s, reembolso);
  return json({ ok: true, ...info, estornadoAgora: true, valorTxt: moneyFmt(valor, s.currency), status: reembolso.status });
}

// Evento charge.refunded: avisa também quando o estorno é feito direto no painel da Stripe
async function estornoNaStripe(env, charge) {
  if (!charge || !charge.payment_intent) return;
  const piId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent.id;
  const lista = await stripe(env, 'GET', `/v1/checkout/sessions?limit=1&payment_intent=${encodeURIComponent(piId)}`);
  const s = (lista.data || [])[0];
  if (!s) return;
  const refunds = await stripe(env, 'GET', `/v1/refunds?limit=1&payment_intent=${encodeURIComponent(piId)}`);
  const r = (refunds.data || [])[0];
  if (!r) return;
  if (String((r.metadata || {}).motivo || '').startsWith('pais_bloqueado')) return; // já avisado no bloqueio
  await avisarEstorno(env, s, r);
}

async function avisarEstorno(env, s, r) {
  const m = s.metadata || {}, L = m.idioma === 'en' ? 'en' : 'pt';
  const valor = moneyFmt(r.amount, r.currency || s.currency), total = moneyFmt(s.amount_total, s.currency);
  const parcial = r.amount < s.amount_total;
  const pedido = s.id.slice(-10).toUpperCase();
  const quando = new Date((r.created || Date.now() / 1000) * 1000);
  const quandoBR = quando.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const quandoEN = quando.toLocaleString('en-GB', { timeZone: 'America/Sao_Paulo' });
  const protocolo = (r.metadata || {}).protocolo || '';
  const emailCliente = m.email || (s.customer_details || {}).email;

  await enviarEmail(env, {
    to: env.SALES_EMAIL,
    subject: `↩️ Estorno feito — ${valor} — ${m.nome || ''}`,
    html: layout(parcial ? 'Estorno parcial feito' : 'Estorno feito', `${tabela([['Pedido', pedido], ['Cliente', m.nome], ['E-mail', emailCliente], ['Plano', m.plano_nome], ['Valor pago', total], ['Valor estornado', valor], ['Situação na Stripe', r.status], ['Data', quandoBR], ['Protocolo', protocolo || '—'], ['ID do estorno', r.id]])}
      <p style="font-size:12px;color:#888">O cliente foi avisado por e-mail.</p>`),
    idempotencia: `estornado-equipe-${r.id}`,
  }).catch(e => console.error('Falha aviso estorno equipe', e && e.message));

  if (!emailCliente) return;
  await enviarEmail(env, {
    to: emailCliente, reply_to: env.SUPPORT_EMAIL || env.SALES_EMAIL,
    subject: L === 'en' ? `Your refund was processed — ${valor} | FNX DEV` : `Seu reembolso foi processado — ${valor} | FNX DEV`,
    html: L === 'en'
      ? layout('Refund processed', `<p>Hi ${esc((m.nome || '').split(' ')[0])}! Your ${parcial ? 'partial ' : ''}refund was processed.</p>
          ${tabela([['Order', pedido], ['Amount paid', total], ['Amount refunded', valor], ['Processed on', quandoEN + ' (Brasília time)'], ...(protocolo ? [['Reference', protocolo]] : [])])}
          <p>Card refunds usually appear on your statement within 5 to 10 business days, depending on your bank.</p>`)
      : layout('Reembolso processado', `<p>Olá, ${esc((m.nome || '').split(' ')[0])}! Seu reembolso ${parcial ? 'parcial ' : ''}foi processado.</p>
          ${tabela([['Pedido', pedido], ['Valor pago', total], ['Valor reembolsado', valor], ['Processado em', quandoBR], ...(protocolo ? [['Protocolo', protocolo]] : [])])}
          <p>No cartão, o estorno costuma aparecer na fatura em 5 a 10 dias úteis, conforme o banco (pode cair na fatura seguinte). No Pix, o valor volta para a conta de origem. No boleto, a Stripe envia ao seu e-mail as instruções para receber o valor.</p>`),
    idempotencia: `estornado-cliente-${r.id}`,
  }).catch(e => console.error('Falha aviso estorno cliente', e && e.message));
}

// ---------------------------------------------------------------------
// 7) CONTRATO ASSINADO (documento + certificado de assinatura)
// ---------------------------------------------------------------------
function normalizaNome(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
async function sha256hex(texto) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function base64Utf8(str) {
  const bytes = new TextEncoder().encode(str); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function lerContrato(env, request, versao, L) {
  const caminho = (CONTRATOS[versao] || CONTRATOS[VERSAO_CONTRATO]).html[L === 'en' ? 'en' : 'pt'];
  const base = request ? new URL(request.url).origin : env.SITE_URL;
  const r = await env.ASSETS.fetch(new Request(base + caminho));
  if (!r.ok) throw new Error('Contrato não encontrado: ' + caminho);
  return await r.text();
}
async function tokenAssinado(env, sessionId) {
  return tokenHmac(env, 'contrato', sessionId);
}

async function montarContratoAssinado(env, s, request) {
  const m = s.metadata || {};
  const L = m.contrato_idioma === 'en' ? 'en' : 'pt';
  const versao = CONTRATOS[m.contrato_versao] ? m.contrato_versao : VERSAO_CONTRATO;
  const texto = await lerContrato(env, request, versao, L);
  const hashAtual = await sha256hex(texto);
  const integro = !!m.contrato_sha256 && hashAtual === m.contrato_sha256;
  const quando = m.aceite_em ? new Date(m.aceite_em) : new Date(s.created * 1000);
  const dataBR = quando.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const dataEN = quando.toLocaleString('en-GB', { timeZone: 'America/Sao_Paulo' });
  const pedido = s.id.slice(-10).toUpperCase();
  const planoInfo = PLANOS[m.plano] || { pt: m.plano_nome, en: m.plano_nome };
  const valor = moneyFmt(s.amount_total, s.currency);
  const t = L === 'en' ? {
    titulo: 'Signed Services Agreement', selo: 'Electronically signed document', por: 'Signed by', em: 'on', cert: 'Electronic signature certificate',
    contratante: 'Client', contratada: 'Service provider', assinatura: 'Signature', ped: 'Order', reg: 'Signature record',
    linhas: [['Signature (typed full name)', m.assinatura_nome], ['Client name', m.nome], ['ID / tax number', m.documento], ['Email', m.email], ['Phone', m.telefone], ['Address', `${m.endereco || ''} — ${m.cidade || ''}, ${m.pais || ''}`], ['Company', m.empresa],
      ['Date and time (Brasília)', dataEN], ['Date and time (UTC)', quando.toISOString()], ['IP address', m.aceite_ip], ['Country of connection', m.aceite_pais_ip], ['Browser', m.user_agent],
      ['Agreement', `Website Development Services Agreement — version ${versao} (English)`], ['SHA-256 of the signed text', m.contrato_sha256], ['Integrity check', integro ? 'Valid — the text below is identical to the text signed' : 'NOT valid — the text differs from the text signed'],
      ['Policies version', m.politicas_versao], ['Early start requested (UK/EU)', m.inicio_antecipado === 'sim' ? 'Yes' : 'No'],
      ['Order', `${pedido} · ${planoInfo.en} plan · ${valor}`], ['Payment reference (Stripe)', s.id]],
    prov: 'Yan Victor Figueiredo Szaida (FNX DEV), Brazilian CPF 073.847.949-78, Rua La Salle, 300, casa 07 – Pinheirinho, Curitiba/PR, CEP 81880-400, Brazil.',
    legal: 'Electronic signature made by typing the full name and ticking the acceptance box after viewing the full text, recognized by the parties under clause 17 of the Agreement and Article 10, § 2, of Brazilian Provisional Measure 2,200-2/2001.',
    salvar: 'Save as PDF / Print',
  } : {
    titulo: 'Contrato de Prestação de Serviços — assinado', selo: 'Documento assinado eletronicamente', por: 'Assinado por', em: 'em', cert: 'Certificado de assinatura eletrônica',
    contratante: 'Contratante', contratada: 'Contratada', assinatura: 'Assinatura', ped: 'Pedido', reg: 'Registro da assinatura',
    linhas: [['Assinatura (nome completo digitado)', m.assinatura_nome], ['Nome do contratante', m.nome], ['CPF / CNPJ / documento', m.documento], ['E-mail', m.email], ['Telefone', m.telefone], ['Endereço', `${m.endereco || ''} — ${m.cidade || ''}, ${m.pais || ''}`], ['Empresa', m.empresa],
      ['Data e hora (Brasília)', dataBR], ['Data e hora (UTC)', quando.toISOString()], ['Endereço IP', m.aceite_ip], ['País da conexão', m.aceite_pais_ip], ['Navegador', m.user_agent],
      ['Contrato', `Contrato de Prestação de Serviços de Desenvolvimento Web — versão ${versao} (português)`], ['SHA-256 do texto assinado', m.contrato_sha256], ['Verificação de integridade', integro ? 'Válida — o texto abaixo é idêntico ao texto assinado' : 'NÃO confere — o texto difere do assinado'],
      ['Versão das políticas', m.politicas_versao], ['Início antecipado (Reino Unido/UE)', m.inicio_antecipado === 'sim' ? 'Sim' : 'Não'],
      ['Pedido', `${pedido} · Plano ${planoInfo.pt} · ${valor}`], ['Referência do pagamento (Stripe)', s.id]],
    prov: 'Yan Victor Figueiredo Szaida (FNX DEV), CPF 073.847.949-78, Rua La Salle, 300, casa 07 – Pinheirinho, Curitiba/PR, CEP 81880-400, Brasil.',
    legal: 'Assinatura eletrônica feita pela digitação do nome completo e marcação da caixa de concordância após a visualização do texto integral, reconhecida pelas partes na cláusula 17 do contrato e no art. 10, § 2º, da MP nº 2.200-2/2001.',
    salvar: 'Salvar em PDF / Imprimir',
  };
  const linhasHtml = t.linhas.filter(([, v]) => v).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="${L === 'en' ? 'en' : 'pt-BR'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.titulo)} — ${pedido}</title><meta name="robots" content="noindex">
<style>
body{font-family:Arial,Helvetica,sans-serif;color:#18181b;max-width:820px;margin:0 auto;padding:28px 22px;line-height:1.55;font-size:14px}
.top{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #FF6A00;padding-bottom:10px;margin-bottom:16px}
.top b{font-size:20px}.top span{color:#FF6A00}
.selo{border:2px solid #16a34a;background:#f0fdf4;border-radius:10px;padding:12px 14px;margin-bottom:18px}
.selo strong{color:#15803d}
h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:18px 0 6px}
p{margin:0 0 8px;text-align:justify} ul{margin:4px 0 10px 20px}
.cert{border:2px solid #18181b;border-radius:10px;padding:16px;margin-top:28px;break-inside:avoid}
.cert h2{margin-top:0}
table{width:100%;border-collapse:collapse;font-size:12.5px} th,td{border-bottom:1px solid #e4e4e7;padding:6px 8px;text-align:left;vertical-align:top} th{width:36%;color:#52525b;font-weight:600}
td{word-break:break-word}
.ass{font-family:"Brush Script MT","Segoe Script","Lucida Handwriting",cursive;font-size:28px;color:#1e3a8a;margin:10px 0 2px}
.btn{position:fixed;right:18px;bottom:18px;background:#FF6A00;color:#fff;border:0;border-radius:10px;padding:12px 16px;font-weight:700;cursor:pointer}
.legal{font-size:11.5px;color:#52525b;margin-top:10px}
@media print{.btn{display:none}body{padding:0}}
</style></head><body>
<div class="top"><b>FNX <span>DEV</span></b><div style="font-size:12px;color:#52525b">dev.fnxholding.com · suporte.fnxtech@gmail.com</div></div>
<div class="selo"><strong>✔ ${esc(t.selo)}</strong><br>${esc(t.por)} <b>${esc(m.assinatura_nome)}</b> ${esc(t.em)} ${esc(L === 'en' ? dataEN : dataBR)} · ${esc(t.ped)} ${pedido} · SHA-256 ${esc((m.contrato_sha256 || '').slice(0, 16))}…</div>
${texto}
<div class="cert">
<h2>${esc(t.cert)}</h2>
<p><b>${esc(t.contratada)}:</b> ${esc(t.prov)}</p>
<p><b>${esc(t.contratante)} — ${esc(t.assinatura)}:</b></p>
<div class="ass">${esc(m.assinatura_nome)}</div>
<p style="font-size:12px;color:#52525b">${esc(m.nome)} · ${esc(m.documento)} · ${esc(L === 'en' ? dataEN : dataBR)}</p>
<h2>${esc(t.reg)}</h2>
<table>${linhasHtml}</table>
<p class="legal">${esc(t.legal)}</p>
</div>
<button class="btn" onclick="window.print()">${esc(t.salvar)}</button>
</body></html>`;
  return { html, integro, dataBR, dataEN };
}

async function rotaContratoAssinado(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get('pedido') || '', t = url.searchParams.get('t') || '';
  if (!/^cs_[A-Za-z0-9_]+$/.test(id) || !t || !igualSeguro(t, await tokenAssinado(env, id))) return new Response('Link inválido / Invalid link', { status: 403 });
  const s = await stripe(env, 'GET', `/v1/checkout/sessions/${id}`);
  if (s.payment_status !== 'paid') return new Response('Pedido não pago / Order not paid', { status: 404 });
  const { html } = await montarContratoAssinado(env, s, request);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' } });
}

// ---------------------------------------------------------------------
// STRIPE
// ---------------------------------------------------------------------
async function stripe(env, metodo, caminho, params, idem) {
  const opts = { method: metodo, headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } };
  if (idem) opts.headers['Idempotency-Key'] = String(idem).slice(0, 255);
  if (params) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = formEncode(params);
  }
  const r = await fetch('https://api.stripe.com' + caminho, opts);
  const j = await r.json();
  if (!r.ok) {
    console.error('Stripe erro', r.status, JSON.stringify(j));
    throw new StripeErro(r.status, j.error || {});
  }
  return j;
}

class StripeErro extends Error {
  constructor(status, err) {
    super('Stripe: ' + (err.message || status));
    this.status = status;
    this.param = err.param || '';
    this.codigo = err.code || err.type || '';
  }
}

// Cria o checkout. Se a Stripe recusar alguma forma de pagamento ou opção
// (ex.: parcelamento ou Pix ainda não liberados na conta), tenta de novo sem ela,
// para a venda não travar. O motivo fica registrado nos logs do Worker.
async function criarCheckout(env, params) {
  const semParcelas = p => { const c = structuredClone(p); if (c.payment_method_options && c.payment_method_options.card) delete c.payment_method_options.card; return c; };
  const semPix = p => { const c = structuredClone(p); c.payment_method_types = (c.payment_method_types || []).filter(t => t !== 'pix'); if (c.payment_method_options) delete c.payment_method_options.pix; return c; };
  const soCartao = p => { const c = structuredClone(p); c.payment_method_types = ['card']; delete c.payment_method_options; return c; };
  // Última tentativa: sem lista de formas de pagamento — a Stripe usa as que estão ativas no painel
  // (Configurações → Formas de pagamento).
  const formasDoPainel = p => { const c = structuredClone(p); delete c.payment_method_types; delete c.payment_method_options; return c; };
  const tentativas = [params, semParcelas(params), semPix(semParcelas(params)), soCartao(params), formasDoPainel(params)];
  let ultimoErro;
  for (let i = 0; i < tentativas.length; i++) {
    if (i > 0 && JSON.stringify(tentativas[i]) === JSON.stringify(tentativas[i - 1])) continue;
    try {
      const sessao = await stripe(env, 'POST', '/v1/checkout/sessions', tentativas[i]);
      if (i > 0) console.warn('Checkout criado na tentativa', i + 1, '— a Stripe recusou:', ultimoErro && ultimoErro.param, ultimoErro && ultimoErro.message);
      return sessao;
    } catch (e) {
      ultimoErro = e;
      const recusaDeFormaDePagamento = e instanceof StripeErro && e.status === 400 && /payment_method|installments|pix|boleto/i.test(e.param + ' ' + e.message);
      if (!recusaDeFormaDePagamento) throw e;
    }
  }
  throw ultimoErro;
}

function formEncode(obj, prefixo, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const chave = prefixo ? `${prefixo}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, chave, out);
    else out.push(encodeURIComponent(chave) + '=' + encodeURIComponent(v));
  }
  return out.join('&');
}

async function assinaturaStripeOk(corpo, header, segredo) {
  if (!header || !segredo) return false;
  const partes = header.split(',');
  const t = (partes.find(p => p.startsWith('t=')) || '').slice(2);
  const v1s = partes.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!t || !v1s.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // 5 min
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(`${t}.${corpo}`));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return v1s.some(v => igualSeguro(v, hex));
}
function igualSeguro(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------------------------------------------------------------------
// E-MAIL (Resend)
// ---------------------------------------------------------------------
async function enviarEmail(env, { to, subject, html, reply_to, idempotencia, anexos }) {
  const enviar = async (comAnexos) => {
    const headers = { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' };
    if (idempotencia) headers['Idempotency-Key'] = (idempotencia + (comAnexos ? '' : '-sem-anexo')).slice(0, 256);
    const corpo = { from: env.RESEND_FROM, to: [to], subject, html, reply_to: reply_to || undefined };
    if (comAnexos && anexos && anexos.length) corpo.attachments = anexos;
    return fetch('https://api.resend.com/emails', { method: 'POST', headers, body: JSON.stringify(corpo) });
  };
  let r = await enviar(true);
  if (!r.ok && anexos && anexos.length) {
    console.error('Resend recusou com anexo, enviando sem anexo', r.status, await r.text());
    r = await enviar(false);
  }
  if (!r.ok) {
    const t = await r.text();
    console.error('Resend erro', r.status, t);
    throw new Error('Falha ao enviar e-mail');
  }
}

function layout(titulo, conteudo) {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
  <div style="max-width:640px;margin:0 auto;padding:24px">
    <div style="background:#0b0b0c;color:#fff;border-radius:14px 14px 0 0;padding:20px 24px;font-weight:900;font-size:20px">FNX <span style="color:#ff6a00">DEV</span></div>
    <div style="background:#fff;border-radius:0 0 14px 14px;padding:24px;line-height:1.55;font-size:14px">
      <h2 style="margin:0 0 14px;font-size:20px">${esc(titulo)}</h2>${conteudo}
    </div>
    <p style="text-align:center;color:#a1a1aa;font-size:12px;margin-top:16px">FNX DEV · suporte.fnxtech@gmail.com · WhatsApp +55 41 99555-3699 · Instagram @yanszaida</p>
  </div></body></html>`;
}
function tabela(linhas) {
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">${linhas.filter(([, v]) => v).map(([k, v]) =>
    `<tr><td style="padding:7px 10px;border-bottom:1px solid #eee;color:#71717a;width:38%;vertical-align:top">${esc(k)}</td><td style="padding:7px 10px;border-bottom:1px solid #eee;font-weight:600">${esc(v)}</td></tr>`).join('')}</table>`;
}
function tabelaCliente(c, plano, valor) {
  const linhas = [];
  if (plano) linhas.push(['Plano', plano]);
  if (valor) linhas.push(['Valor', valor]);
  linhas.push(['Nome', c.nome], ['E-mail', c.email], ['WhatsApp', c.telefone], ['CPF/CNPJ/Documento', c.documento],
    ['Empresa', c.empresa], ['Endereço', c.endereco], ['Cidade/Estado', c.cidade], ['País', c.pais], ['Site/Instagram', c.site]);
  return tabela(linhas) + (c.descricao ? `<h3 style="margin:16px 0 6px;font-size:15px">O que pediu</h3><p style="white-space:pre-wrap;background:#fafafa;border-radius:8px;padding:12px">${esc(c.descricao)}</p>` : '');
}
function metaParaCliente(m) {
  return {
    nome: m.nome || '', email: m.email || '', telefone: m.telefone || '', documento: m.documento || '',
    empresa: m.empresa || '', endereco: m.endereco || '', cidade: m.cidade || '', pais: m.pais || '', site: m.site || '',
    descricao: [m.desc_1, m.desc_2, m.desc_3].filter(Boolean).join(''),
  };
}

// ---------------------------------------------------------------------
// UTILITÁRIOS
// ---------------------------------------------------------------------
function idioma(d) { return d && d.idioma === 'en' ? 'en' : 'pt'; }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function erro(msg) { return json({ ok: false, erro: msg }, 400); }
async function lerJson(request) {
  const tamanho = Number(request.headers.get('Content-Length') || 0);
  if (tamanho > 20000) throw new Error('payload grande demais');
  try { return await request.json(); } catch { return {}; }
}
function limpa(v, max, multilinha = false) {
  let s = String(v ?? '').trim();
  if (!multilinha) s = s.replace(/\s+/g, ' ');
  return s.slice(0, max);
}
function emailOk(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e || ''); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function moneyFmt(centavos, moeda) {
  const v = (centavos || 0) / 100;
  return (moeda || '').toLowerCase() === 'brl'
    ? v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : v.toLocaleString('en-US', { style: 'currency', currency: (moeda || 'usd').toUpperCase() });
}
function waLink(tel) { return 'https://wa.me/' + String(tel || '').replace(/\D/g, ''); }
function cpfValido(c) {
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  let s = 0; for (let i = 0; i < 9; i++) s += +c[i] * (10 - i);
  let d = (s * 10) % 11 % 10; if (d !== +c[9]) return false;
  s = 0; for (let i = 0; i < 10; i++) s += +c[i] * (11 - i);
  d = (s * 10) % 11 % 10; return d === +c[10];
}
function cnpjValido(c) {
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const calc = n => { let s = 0, p = n - 7; for (let i = 0; i < n; i++) { s += +c[i] * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return calc(12) === +c[12] && calc(13) === +c[13];
}
