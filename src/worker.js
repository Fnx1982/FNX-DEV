/**
 * FNX DEV — Worker (Cloudflare)
 * --------------------------------------------------------------
 * Serve o site (pasta /public) e as rotas da API:
 *   POST /api/checkout        → valida o pré-cadastro e cria o pagamento na Stripe
 *   POST /api/personalizado   → pedido de orçamento (e-mail p/ vendas + cópia p/ cliente)
 *   POST /api/contato         → mensagem do formulário de contato
 *   POST /api/stripe-webhook  → Stripe avisa que pagou → e-mail com dados + contrato
 *
 * Variáveis (wrangler.jsonc → "vars"):
 *   SITE_URL, SALES_EMAIL, SUPPORT_EMAIL, RESEND_FROM, PAYMENT_METHODS_BRL
 * Segredos (Cloudflare → Worker → Settings → Variables and Secrets → tipo "Secret"):
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY
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
// Deixe vazio por enquanto. Quando tiver o texto, cole entre as crases.
// Campos trocados automaticamente:
// {{NOME}} {{DOCUMENTO}} {{EMAIL}} {{TELEFONE}} {{ENDERECO}} {{CIDADE}} {{PAIS}}
// {{EMPRESA}} {{PLANO}} {{VALOR}} {{DATA}} {{PEDIDO}} {{DESCRICAO}}
const CONTRATO_TEXTO = ``;      // contrato em português (clientes do Brasil)
const CONTRATO_TEXTO_EN = ``;   // contrato em inglês (clientes do exterior) — se vazio, usa o português
const VERSAO_POLITICAS = '2026-11-09';

// ============ TEXTOS PARA O CLIENTE ============
const MSG = {
  pt: {
    plano: 'Plano inválido.', obrig: 'Preencha todos os campos obrigatórios.', desc: 'Descreva rapidamente o projeto.',
    email: 'E-mail inválido.', pais: 'País inválido.', paisNao: 'Infelizmente não atendemos o país selecionado.',
    local: 'Infelizmente não atendemos a sua localização.', doc: 'CPF ou CNPJ inválido.',
    aceites: 'É preciso aceitar os termos e as políticas.', privacidade: 'É preciso aceitar a Política de Privacidade.',
    interno: 'Erro interno. Tente novamente ou fale com a gente pelo WhatsApp.',
  },
  en: {
    plano: 'Invalid plan.', obrig: 'Please fill in all required fields.', desc: 'Please briefly describe the project.',
    email: 'Invalid email.', pais: 'Invalid country.', paisNao: "Sorry, we don't serve the selected country.",
    local: "Sorry, we don't serve your location.", doc: 'Invalid CPF or CNPJ.',
    aceites: 'You must accept the terms and policies.', privacidade: 'You must accept the Privacy Policy.',
    interno: 'Internal error. Please try again or reach us on WhatsApp.',
  },
};

// =====================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'POST') return json({ ok: false, erro: 'Método não permitido' }, 405);
      try {
        switch (url.pathname) {
          case '/api/checkout': return await rotaCheckout(request, env);
          case '/api/personalizado': return await rotaPersonalizado(request, env);
          case '/api/contato': return await rotaContato(request, env);
          case '/api/stripe-webhook': return await rotaWebhook(request, env);
        }
        return json({ ok: false, erro: 'Rota não encontrada' }, 404);
      } catch (e) {
        console.error('Erro na API', url.pathname, e && e.stack || e);
        return json({ ok: false, erro: MSG.pt.interno + ' / ' + MSG.en.interno }, 500);
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

  const sessao = await stripe(env, 'POST', '/v1/checkout/sessions', params);

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
  const fimGarantia = new Date(hoje.getTime() + 7 * 24 * 3600 * 1000);
  const fimBR = fimGarantia.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const fimEN = fimGarantia.toLocaleDateString('en-US', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: 'long', day: 'numeric' });
  const dados = { ...cliente, plano: planoInfo[L], valor, data: L === 'en' ? hoje.toLocaleDateString('en-US', { timeZone: 'America/Sao_Paulo' }) : dataBR, pedido };
  const contratoCliente = montarContrato(dados, L);
  const contratoVendas = montarContrato({ ...dados, plano: planoInfo.pt, data: dataBR }, L);

  // E-mail para você (vendas): dados + pedido + contrato
  await enviarEmail(env, {
    to: env.SALES_EMAIL,
    reply_to: cliente.email,
    subject: `💰 Nova venda: Plano ${planoInfo.pt} — ${cliente.nome} (${valor})`,
    html: layout('Nova compra confirmada', `
      <p><b>Pagamento confirmado.</b> Entre em contato com o cliente em até 1 dia útil.</p>
      <p style="background:#fff7f0;border-left:3px solid #ff6a00;padding:10px 12px;border-radius:0 8px 8px 0">
        <b>Garantia de 7 dias até ${fimBR}.</b> Pode fazer briefing e prévias, mas só publique / entregue arquivos e acessos depois dessa data.</p>
      <h3 style="margin:18px 0 8px">Pedido</h3>
      ${tabela([['Pedido', pedido], ['Plano', planoInfo.pt], ['Valor', valor], ['Forma de pagamento', (charge && charge.payment_method_details && charge.payment_method_details.type) || (s.payment_method_types || []).join(', ')], ['Data', dataBR], ['Fim da garantia (7 dias)', fimBR], ['Idioma do cliente', L === 'en' ? 'Inglês' : 'Português']])}
      <h3 style="margin:18px 0 8px">Cliente</h3>
      ${tabelaCliente(cliente)}
      <h3 style="margin:18px 0 8px">Aceite das políticas</h3>
      ${tabela([['Aceito em', m.aceite_em], ['IP', m.aceite_ip], ['País do IP', m.aceite_pais_ip], ['Versão das políticas', m.politicas_versao], ['Navegador', m.user_agent]])}
      <h3 style="margin:18px 0 8px">Contrato</h3>
      ${contratoVendas}
      <p style="margin-top:18px"><a href="${waLink(cliente.telefone)}">Chamar cliente no WhatsApp</a> · <a href="https://dashboard.stripe.com/payments/${esc(s.payment_intent && s.payment_intent.id || '')}">Ver na Stripe</a></p>`),
    idempotencia: `venda-${s.id}`,
  });

  // E-mail para o cliente (no idioma dele)
  const primeiro = esc(cliente.nome.split(' ')[0]);
  const suporte = esc(env.SUPPORT_EMAIL || env.SALES_EMAIL);
  const html = L === 'en'
    ? layout('Payment confirmed!', `
      <p>Hi ${primeiro}! Thank you for choosing FNX DEV.</p>
      <p>We received your payment for the <b>${esc(planoInfo.en)} plan</b> (${esc(valor)}). We'll contact you by WhatsApp or email within <b>1 business day</b> to go over the briefing.</p>
      ${tabela([['Order', pedido], ['Plan', planoInfo.en], ['Amount', valor], ['Date', dados.data]])}
      <h3 style="margin:18px 0 8px">Contract</h3>
      ${contratoCliente}
      <p style="margin-top:18px;font-size:13px;color:#666"><b>7-day guarantee:</b> if you change your mind by ${esc(fimEN)}, reply to this email or write to ${suporte} and we'll refund 100%. Launch and handover happen after that date.
      Policies: <a href="${env.SITE_URL}/policies.html">${env.SITE_URL}/policies.html</a></p>`)
    : layout('Pagamento confirmado!', `
      <p>Olá, ${primeiro}! Obrigado por escolher a FNX DEV.</p>
      <p>Recebemos o pagamento do <b>Plano ${esc(planoInfo.pt)}</b> (${esc(valor)}). Vamos entrar em contato pelo WhatsApp ou e-mail em até <b>1 dia útil</b> para alinhar o briefing.</p>
      ${tabela([['Pedido', pedido], ['Plano', planoInfo.pt], ['Valor', valor], ['Data', dataBR]])}
      <h3 style="margin:18px 0 8px">Contrato</h3>
      ${contratoCliente}
      <p style="margin-top:18px;font-size:13px;color:#666"><b>Garantia de 7 dias:</b> se desistir até ${fimBR}, responda este e-mail ou escreva para ${suporte} e devolvemos 100% do valor. A publicação e a entrega acontecem depois dessa data.
      Políticas: <a href="${env.SITE_URL}/politicas.html">${env.SITE_URL}/politicas.html</a></p>`);

  await enviarEmail(env, {
    to: cliente.email,
    reply_to: env.SALES_EMAIL,
    subject: L === 'en' ? `Payment confirmed — ${planoInfo.en} plan | FNX DEV` : `Pagamento confirmado — Plano ${planoInfo.pt} | FNX DEV`,
    html,
    idempotencia: `cliente-${s.id}`,
  });
}

function montarContrato(c, L) {
  const texto = (L === 'en' && CONTRATO_TEXTO_EN.trim()) ? CONTRATO_TEXTO_EN : CONTRATO_TEXTO;
  if (!texto.trim()) {
    return L === 'en'
      ? `<div style="border:2px dashed #ff6a00;border-radius:10px;padding:16px;color:#555;background:#fff7f0">
          <b>[CONTRACT — PLACEHOLDER]</b><br>The service agreement will be sent here with your details (name, ID, address, plan, amount and date).</div>`
      : `<div style="border:2px dashed #ff6a00;border-radius:10px;padding:16px;color:#555;background:#fff7f0">
          <b>[CONTRATO — ESPAÇO RESERVADO]</b><br>O texto do contrato de prestação de serviços será inserido aqui, com os dados acima (nome, documento, endereço, plano, valor e data).</div>`;
  }
  const mapa = {
    NOME: c.nome, DOCUMENTO: c.documento, EMAIL: c.email, TELEFONE: c.telefone, ENDERECO: c.endereco,
    CIDADE: c.cidade, PAIS: c.pais, EMPRESA: c.empresa || '—', PLANO: c.plano, VALOR: c.valor,
    DATA: c.data, PEDIDO: c.pedido, DESCRICAO: c.descricao,
  };
  const final = texto.replace(/\{\{(\w+)\}\}/g, (_, k) => mapa[k] ?? '');
  return `<div style="border:1px solid #ddd;border-radius:10px;padding:18px;white-space:pre-wrap;font-size:13px;line-height:1.6">${esc(final)}</div>`;
}

// ---------------------------------------------------------------------
// STRIPE
// ---------------------------------------------------------------------
async function stripe(env, metodo, caminho, params) {
  const opts = { method: metodo, headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } };
  if (params) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = formEncode(params);
  }
  const r = await fetch('https://api.stripe.com' + caminho, opts);
  const j = await r.json();
  if (!r.ok) {
    console.error('Stripe erro', r.status, JSON.stringify(j));
    throw new Error('Stripe: ' + (j.error && j.error.message || r.status));
  }
  return j;
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
async function enviarEmail(env, { to, subject, html, reply_to, idempotencia }) {
  const headers = { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' };
  if (idempotencia) headers['Idempotency-Key'] = idempotencia.slice(0, 256);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers,
    body: JSON.stringify({ from: env.RESEND_FROM, to: [to], subject, html, reply_to: reply_to || undefined }),
  });
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
