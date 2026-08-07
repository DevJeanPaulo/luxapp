/**
 * Cloud Functions — Lux Transfers
 * Scaffold para pagamentos Stripe e notificações push (Firebase Cloud Messaging).
 *
 * Antes do deploy:
 *   1. cd functions && npm install
 *   2. firebase functions:secrets:set STRIPE_SECRET_KEY   (cola a tua chave secreta sk_live_/sk_test_)
 *   3. firebase deploy --only functions
 *
 * Depois do deploy, copia o URL da função createPaymentIntent para a constante
 * CREATE_PAYMENT_INTENT_URL em lux-cliente.html e luxdriver-motorista.html.
 */

const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentUpdated, onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const Stripe = require('stripe');
const cors = require('cors')({ origin: true });
const { Translate } = require('@google-cloud/translate').v2;

admin.initializeApp();

const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');
const specialAccountsJson = defineSecret('SPECIAL_ACCOUNTS_JSON');
const adminCredentialsJson = defineSecret('ADMIN_CREDENTIALS_JSON');

/**
 * Cria um PaymentIntent Stripe e devolve o client_secret ao frontend.
 * Chamada por lux-cliente.html (pagamento de viagem) e luxdriver-motorista.html (recarga de saldo).
 *
 * Espera um POST JSON: { amount: <cêntimos>, currency: "eur" }
 * Devolve: { clientSecret: "..." }
 */
exports.createPaymentIntent = onRequest({ secrets: [stripeSecretKey] }, (req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }
    try {
      const stripe = Stripe(stripeSecretKey.value());
      const { amount, currency } = req.body || {};
      if (!amount || !currency) {
        res.status(400).json({ error: 'amount e currency são obrigatórios.' });
        return;
      }
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency,
        automatic_payment_methods: { enabled: true }
      });
      res.status(200).json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
      console.error('createPaymentIntent falhou:', err);
      res.status(500).json({ error: err.message });
    }
  });
});

/**
 * Reembolsa (total ou parcialmente) o PaymentIntent original de uma
 * corrida/reserva. Chamada por lux-cliente.html e luxdriver-motorista.html
 * nos vários cenários de cancelamento com reembolso (corrida imediata
 * cancelada dentro/fora dos 3 min grátis, reserva cancelada pelo cliente).
 *
 * Espera um POST JSON: { paymentIntentId: "pi_...", amount: <cêntimos, opcional> }
 * Sem "amount", reembolsa o valor total do PaymentIntent. Devolve: { refundId, status }
 */
exports.refundPayment = onRequest({ secrets: [stripeSecretKey] }, (req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }
    try {
      const stripe = Stripe(stripeSecretKey.value());
      const { paymentIntentId, amount } = req.body || {};
      if (!paymentIntentId) {
        res.status(400).json({ error: 'paymentIntentId é obrigatório.' });
        return;
      }
      const params = { payment_intent: paymentIntentId };
      if (amount != null && amount > 0) params.amount = Math.round(amount);
      const refund = await stripe.refunds.create(params);
      res.status(200).json({ refundId: refund.id, status: refund.status });
    } catch (err) {
      console.error('refundPayment falhou:', err);
      res.status(500).json({ error: err.message });
    }
  });
});

/**
 * Cria um SetupIntent Stripe (sem cobrança) e um Customer associado, para
 * guardar um cartão real no registo de novos clientes/motoristas.
 * Chamada por lux-cliente.html e luxdriver-motorista.html logo após a
 * verificação de email + SMS ser concluída com sucesso.
 *
 * Espera um POST JSON: { email: "...", name: "..." }
 * Devolve: { clientSecret: "...", customerId: "..." }
 */
exports.createSetupIntent = onRequest({ secrets: [stripeSecretKey] }, (req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }
    try {
      const stripe = Stripe(stripeSecretKey.value());
      const { email, name } = req.body || {};
      const customer = await stripe.customers.create({
        email: email || undefined,
        name: name || undefined
      });
      const setupIntent = await stripe.setupIntents.create({
        customer: customer.id,
        payment_method_types: ['card']
      });
      res.status(200).json({ clientSecret: setupIntent.client_secret, customerId: customer.id });
    } catch (err) {
      console.error('createSetupIntent falhou:', err);
      res.status(500).json({ error: err.message });
    }
  });
});

/**
 * Verifica se um login corresponde a uma "conta especial" (acesso ilimitado —
 * saldo infinito para motorista, sem pagamento para cliente) sem NUNCA expor
 * essas credenciais no código do frontend. As credenciais reais só existem
 * no secret SPECIAL_ACCOUNTS_JSON (Secret Manager), nunca no repositório.
 *
 * Antes do deploy:
 *   firebase functions:secrets:set SPECIAL_ACCOUNTS_JSON
 *   (cola um JSON como:
 *    {"d":{"email":"...","pass":"...","name":"..."},"c":{"email":"...","pass":"...","name":"..."}})
 *
 * Espera um POST JSON: { role: "c"|"d", email: "...", password: "..." }
 * Devolve: { unlimited: true, name: "..." } ou { unlimited: false }
 */
exports.checkSpecialAccount = onRequest({ secrets: [specialAccountsJson] }, (req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }
    try {
      const { role, email, password } = req.body || {};
      if (!role || !email || !password) {
        res.status(200).json({ unlimited: false });
        return;
      }
      let accounts = {};
      try { accounts = JSON.parse(specialAccountsJson.value() || '{}'); } catch (e) { accounts = {}; }
      const acc = accounts[role];
      const match = acc && acc.email && acc.pass
        && String(acc.email).toLowerCase() === String(email).toLowerCase()
        && acc.pass === password;
      if (match) {
        res.status(200).json({ unlimited: true, name: acc.name || '' });
      } else {
        res.status(200).json({ unlimited: false });
      }
    } catch (err) {
      console.error('checkSpecialAccount falhou:', err);
      res.status(500).json({ unlimited: false, error: err.message });
    }
  });
});

/**
 * Verifica as credenciais de login do painel admin sem NUNCA expor a
 * password real no código do frontend. A password real só existe no secret
 * ADMIN_CREDENTIALS_JSON (Secret Manager), nunca no repositório.
 *
 * Antes do deploy:
 *   firebase functions:secrets:set ADMIN_CREDENTIALS_JSON
 *   (cola um JSON como:
 *    {"email":"adm@luxtransfers.pt","pass":"a-tua-password-aqui"})
 *
 * Espera um POST JSON: { email: "...", password: "..." }
 * Devolve: { valid: true } ou { valid: false }
 */
exports.checkAdminLogin = onRequest({ secrets: [adminCredentialsJson] }, (req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        res.status(200).json({ valid: false });
        return;
      }
      let admins = {};
      try { admins = JSON.parse(adminCredentialsJson.value() || '{}'); } catch (e) { admins = {}; }
      const match = admins.email && admins.pass
        && String(admins.email).toLowerCase() === String(email).toLowerCase()
        && admins.pass === password;
      res.status(200).json({ valid: !!match });
    } catch (err) {
      console.error('checkAdminLogin falhou:', err);
      res.status(500).json({ valid: false, error: err.message });
    }
  });
});

/**
 * Documentos obrigatórios de motorista (têm de coincidir com DRIVER_DOCS
 * em admin-panel.html) — usados para saber que chaves aceitar/guardar.
 */
const DRIVER_DOC_KEYS = ['licenca', 'cc', 'crc', 'dua', 'seguro', 'ipo'];

/**
 * Cria um novo utilizador (cliente ou motorista) diretamente a partir do
 * painel de administração. Usa o Admin SDK porque o SDK do lado do
 * cliente não permite criar outra conta no Firebase Auth sem terminar a
 * sessão do próprio admin.
 *
 * Autorização: reutiliza o mesmo secret ADMIN_CREDENTIALS_JSON já usado no
 * login do painel — o pedido tem de incluir o email/password do admin,
 * validados aqui no servidor antes de qualquer alteração.
 *
 * Espera um POST JSON:
 * {
 *   idToken,                             // preferido: ID token do admin autenticado via Firebase Auth
 *   adminEmail, adminPassword,           // alternativa: credenciais do admin (fallback sem Firebase Auth)
 *   tipo: "cliente" | "motorista",
 *   nome, email, password, telefone,
 *   documentos: {                        // só para tipo === "motorista", opcional por chave
 *     licenca: { dataUrl: "data:image/...;base64,...", fileName: "..." },
 *     cc: {...}, crc: {...}, dua: {...}, seguro: {...}, ipo: {...}
 *   }
 * }
 * Devolve: { ok: true, uid: "..." } ou { error: "..." }
 */
exports.adminCreateUser = onRequest({ secrets: [adminCredentialsJson], timeoutSeconds: 120 }, (req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }
    try {
      const {
        idToken, adminEmail, adminPassword,
        tipo, nome, email, password, telefone,
        documentos
      } = req.body || {};

      // 1) Confirma que quem chama é mesmo o admin — por ID token do Firebase
      // Auth (preferido) ou, em alternativa, pelo mesmo secret do login antigo.
      let admins = {};
      try { admins = JSON.parse(adminCredentialsJson.value() || '{}'); } catch (e) { admins = {}; }
      let isAdmin = false;
      if (idToken) {
        try {
          const decoded = await admin.auth().verifyIdToken(idToken);
          isAdmin = !!(admins.email && decoded.email
            && String(admins.email).toLowerCase() === String(decoded.email).toLowerCase());
        } catch (e) {
          isAdmin = false;
        }
      } else {
        isAdmin = !!(admins.email && admins.pass
          && String(admins.email).toLowerCase() === String(adminEmail || '').toLowerCase()
          && admins.pass === adminPassword);
      }
      if (!isAdmin) {
        res.status(403).json({ error: 'Não autorizado.' });
        return;
      }

      // 2) Valida os dados do novo utilizador.
      if (!tipo || (tipo !== 'cliente' && tipo !== 'motorista')) {
        res.status(400).json({ error: 'Tipo tem de ser "cliente" ou "motorista".' });
        return;
      }
      if (!nome || !email || !password) {
        res.status(400).json({ error: 'Nome, email e password são obrigatórios.' });
        return;
      }
      if (String(password).length < 6) {
        res.status(400).json({ error: 'A password tem de ter pelo menos 6 caracteres.' });
        return;
      }

      // 3) Cria a conta no Firebase Auth.
      const userRecord = await admin.auth().createUser({
        email: String(email).trim(),
        password: String(password),
        displayName: nome
      });
      const uid = userRecord.uid;

      // 4) Cria o registo correspondente no Firestore.
      const db = admin.firestore();
      if (tipo === 'cliente') {
        await db.collection('clients').doc(uid).set({
          name: nome,
          email: String(email).trim(),
          phone: telefone || '',
          criadoPeloAdmin: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } else {
        // Motorista: faz upload dos documentos (se enviados) para o Storage
        // e monta o mapa "documents" com o mesmo formato usado no resto do painel.
        const documentsMap = {};
        if (documentos && typeof documentos === 'object') {
          const bucket = admin.storage().bucket();
          for (const key of DRIVER_DOC_KEYS) {
            const doc = documentos[key];
            if (!doc || !doc.dataUrl) continue;
            try {
              const matches = /^data:(.+?);base64,(.+)$/.exec(doc.dataUrl);
              if (!matches) continue;
              const contentType = matches[1];
              const buffer = Buffer.from(matches[2], 'base64');
              const ext = (doc.fileName && doc.fileName.includes('.'))
                ? doc.fileName.split('.').pop()
                : (contentType.split('/')[1] || 'bin');
              const filePath = 'driver_documents/' + uid + '/' + key + '.' + ext;
              const file = bucket.file(filePath);
              await file.save(buffer, { contentType });
              await file.makePublic().catch(function (e) {
                console.warn('makePublic falhou para ' + filePath + ':', e.message);
              });
              documentsMap[key] = {
                url: 'https://storage.googleapis.com/' + bucket.name + '/' + filePath,
                status: 'approved',
                fileName: doc.fileName || (key + '.' + ext)
              };
            } catch (docErr) {
              console.warn('Falha ao guardar documento "' + key + '":', docErr.message);
            }
          }
        }

        await db.collection('drivers').doc(uid).set({
          name: nome,
          email: String(email).trim(),
          phone: telefone || '',
          status: 'approved',
          documents: documentsMap,
          criadoPeloAdmin: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // Espelha o nome em driver_locations/{uid}, tal como acontece noutros
        // pontos do painel, para que apareça corretamente no ecrã "Ao vivo".
        await db.collection('driver_locations').doc(uid).set({ name: nome }, { merge: true }).catch(function () {});
      }

      res.status(200).json({ ok: true, uid });
    } catch (err) {
      console.error('adminCreateUser falhou:', err);
      const message = (err && err.code === 'auth/email-already-exists')
        ? 'Já existe uma conta com este email.'
        : (err && err.message) || 'Erro desconhecido.';
      res.status(500).json({ error: message });
    }
  });
});

/**
 * ===================== FATURAS XML (Stripe → XML tipo SAF-T) =====================
 * Gera automaticamente um ficheiro XML por cada pagamento Stripe concluído e
 * guarda-o no Firebase Storage (pasta faturas-xml/), com metadados espelhados
 * na coleção Firestore "invoices_xml" (é essa coleção que alimenta a tabela
 * "Faturas XML" no painel admin).
 *
 * IMPORTANTE — nota de conformidade fiscal: o XML gerado aqui segue uma
 * estrutura inspirada no SAF-T-PT (cabeçalho + documento de venda) apenas
 * como registo interno de apoio à contabilidade. NÃO é emitido por software
 * de faturação certificado pela Autoridade Tributária (requisito legal em
 * Portugal para faturas válidas), pelo que este ficheiro NÃO substitui a
 * fatura fiscal oficial. Para emitir faturas legalmente válidas é necessário
 * usar um programa de faturação certificado pela AT.
 *
 * Antes do deploy:
 *   1. No Stripe Dashboard → Developers → Webhooks, cria um endpoint apontando
 *      para o URL da função stripeWebhook (depois do deploy) para o evento
 *      "checkout.session.completed", e copia o "Signing secret" (whsec_...).
 *   2. firebase functions:secrets:set STRIPE_WEBHOOK_SECRET   (cola o whsec_...)
 *   3. Confirma que o Firebase Storage está ativado no projeto (Firebase
 *      Console → Storage → Começar).
 *   4. firebase deploy --only functions
 */
const stripeWebhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');

function escapeXml(str) {
  return String(str == null ? '' : str).replace(/[<>&'"]/g, function (c) {
    return { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c];
  });
}

/**
 * Monta o XML (estrutura tipo SAF-T-PT, apenas para registo interno — ver
 * nota de conformidade acima) de uma fatura a partir dos dados do pagamento.
 */
function buildFaturaXml({ id, cliente, email, valor, moeda, data }) {
  const dataISO = data || new Date().toISOString();
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!-- Documento gerado automaticamente pela Lux Transfers. NAO constitui um ficheiro SAF-T-PT certificado pela Autoridade Tributaria — serve apenas como registo interno de apoio a contabilidade. -->\n' +
    '<AuditFile xmlns="urn:OECD:StandardAuditFile-Tax:PT_1.04_01">\n' +
    '  <Header>\n' +
    '    <AuditFileVersion>1.04_01</AuditFileVersion>\n' +
    '    <CompanyName>Lux Transfers</CompanyName>\n' +
    '    <TaxAccountingBasis>F</TaxAccountingBasis>\n' +
    '  </Header>\n' +
    '  <SourceDocuments>\n' +
    '    <SalesInvoices>\n' +
    '      <Invoice>\n' +
    '        <InvoiceNo>FT ' + escapeXml(id) + '</InvoiceNo>\n' +
    '        <InvoiceDate>' + escapeXml(String(dataISO).slice(0, 10)) + '</InvoiceDate>\n' +
    '        <InvoiceType>FT</InvoiceType>\n' +
    '        <CustomerInfo>\n' +
    '          <Name>' + escapeXml(cliente || 'Cliente') + '</Name>\n' +
    '          <Email>' + escapeXml(email || '') + '</Email>\n' +
    '        </CustomerInfo>\n' +
    '        <DocumentTotals>\n' +
    '          <GrossTotal>' + Number(valor || 0).toFixed(2) + '</GrossTotal>\n' +
    '          <Currency>' + escapeXml(moeda || 'EUR') + '</Currency>\n' +
    '        </DocumentTotals>\n' +
    '        <PaymentReference>' + escapeXml(id) + '</PaymentReference>\n' +
    '      </Invoice>\n' +
    '    </SalesInvoices>\n' +
    '  </SourceDocuments>\n' +
    '</AuditFile>\n';
}

/**
 * Gera o XML, guarda-o no Storage (faturas-xml/fatura_{id}.xml) e escreve os
 * metadados em Firestore (invoices_xml/{id}) para a tabela do painel admin.
 */
async function gerarESalvarFaturaXml({ id, cliente, email, valor, moeda, data }) {
  if (!id) throw new Error('id é obrigatório.');
  const xml = buildFaturaXml({ id, cliente, email, valor, moeda, data });
  const fileName = 'fatura_' + id + '.xml';
  const filePath = 'faturas-xml/' + fileName;
  const bucket = admin.storage().bucket();
  const file = bucket.file(filePath);
  await file.save(Buffer.from(xml, 'utf8'), { contentType: 'application/xml; charset=utf-8' });
  await file.makePublic().catch(function (e) { console.warn('makePublic falhou (verifica as regras do Storage):', e.message); });
  const downloadUrl = 'https://storage.googleapis.com/' + bucket.name + '/' + filePath;
  await admin.firestore().collection('invoices_xml').doc(String(id)).set({
    id: String(id),
    cliente: cliente || '',
    email: email || '',
    valor: Number(valor || 0),
    moeda: moeda || 'EUR',
    data: data || new Date().toISOString(),
    fileName,
    storagePath: filePath,
    downloadUrl,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return { fileName, downloadUrl };
}

/**
 * Webhook do Stripe — chamado automaticamente pelo Stripe a cada evento.
 * No evento "checkout.session.completed", gera e guarda o XML da fatura.
 * A assinatura do pedido é sempre verificada com o STRIPE_WEBHOOK_SECRET,
 * para garantir que o pedido vem mesmo do Stripe.
 */
exports.stripeWebhook = onRequest({ secrets: [stripeSecretKey, stripeWebhookSecret] }, async (req, res) => {
  let event;
  try {
    const stripe = Stripe(stripeSecretKey.value());
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.rawBody, sig, stripeWebhookSecret.value());
  } catch (err) {
    console.error('Assinatura do webhook Stripe inválida:', err.message);
    res.status(400).send('Webhook Error: ' + err.message);
    return;
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const id = session.payment_intent || session.id;
      const cliente = (session.customer_details && session.customer_details.name) || '';
      const email = (session.customer_details && session.customer_details.email) || '';
      const valor = (session.amount_total || 0) / 100;
      const moeda = (session.currency || 'eur').toUpperCase();
      await gerarESalvarFaturaXml({ id, cliente, email, valor, moeda, data: new Date().toISOString() });
      console.log('Fatura XML gerada para', id);
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('stripeWebhook falhou:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Endpoint manual para gerar uma fatura XML fora do fluxo Stripe (ex.: pagamentos
 * feitos fora da plataforma). Chamado pelo painel admin (secção "Faturas XML").
 *
 * Espera um POST JSON: { id, cliente, email, valor, moeda }
 * Devolve: { ok:true, fileName, downloadUrl }
 */
exports.gerarFaturaXml = onRequest({}, (req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }
    try {
      const { id, cliente, email, valor, moeda, data } = req.body || {};
      if (!id || valor == null) {
        res.status(400).json({ error: 'id e valor são obrigatórios.' });
        return;
      }
      const result = await gerarESalvarFaturaXml({ id, cliente, email, valor, moeda, data });
      res.status(200).json({ ok: true, fileName: result.fileName, downloadUrl: result.downloadUrl });
    } catch (err) {
      console.error('gerarFaturaXml falhou:', err);
      res.status(500).json({ error: err.message });
    }
  });
});

/**
 * Envia uma notificação push a um único dispositivo via FCM.
 */
async function sendPush(token, title, body) {
  if (!token) return;
  try {
    await admin.messaging().send({ token, notification: { title, body: body || '' } });
  } catch (err) {
    console.error('sendPush falhou:', err);
  }
}

/**
 * Exemplo ilustrativo: quando o campo "status" de uma viagem muda em Firestore
 * (coleção "rides"), notifica automaticamente o cliente certo.
 * Adapta os nomes de coleção/campos ao teu modelo de dados real — isto é só
 * um ponto de partida para ligares o fluxo do app aos pushes reais.
 *
 * Espera documentos como:
 *   rides/{rideId} = { status: 'driver_assigned', clientId: 'uid123', ... }
 *   users/{uid}     = { fcmToken: '...' }
 */
exports.onRideStatusChanged = onDocumentUpdated('rides/{rideId}', async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!after || !before || before.status === after.status) return;

  const messages = {
    driver_assigned: { title: 'Motorista encontrado', body: 'O seu chauffeur está a caminho.' },
    driver_arrived:  { title: 'O motorista chegou', body: 'O seu chauffeur está à sua espera.' },
    trip_started:    { title: 'Viagem iniciada', body: 'Boa viagem!' },
    trip_completed:  { title: 'Viagem concluída', body: 'Obrigado por viajar com a Lux Transfers.' }
  };
  const msg = messages[after.status];
  if (!msg || !after.clientId) return;

  const userDoc = await admin.firestore().collection('users').doc(after.clientId).get();
  const token = userDoc.exists ? userDoc.data().fcmToken : null;
  await sendPush(token, msg.title, msg.body);
});

/**
 * ===================== CONVIDAR AMIGOS (referral) =====================
 * Mesma lógica de "id do documento" usada no frontend (clientDocId ->
 * sanitizeSessionKey em lux-cliente.html): email em minúsculas, tudo o que
 * não for a-z0-9 vira "_". Tem de ficar sempre igual dos dois lados.
 */
function clientDocIdFromEmail(email) {
  return String(email || '').toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 120);
}

/**
 * Debita crédito (saldo de convites) da conta do cliente, de forma atómica —
 * é a ÚNICA forma de o campo "credits" ser reduzido a partir do frontend.
 * Chamada por lux-cliente.html mesmo antes de criar o PaymentIntent Stripe,
 * para descontar o crédito disponível do valor da viagem. As regras do
 * Firestore bloqueiam qualquer escrita direta do cliente a "credits", por
 * isso esta função (Admin SDK, ignora as regras) é o único caminho possível.
 *
 * Espera um POST JSON: { email, amount }  (amount em euros, > 0)
 * Devolve: { ok:true, newCredits } ou { ok:false, error }
 */
exports.consumeClientCredits = onRequest({}, (req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }
    try {
      const { email, amount } = req.body || {};
      const amt = Number(amount);
      if (!email || !(amt > 0)) {
        res.status(400).json({ ok: false, error: 'email e amount (>0) são obrigatórios.' });
        return;
      }
      const db = admin.firestore();
      const ref = db.collection('clients').doc(clientDocIdFromEmail(email));
      const newCredits = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const current = (snap.exists && typeof snap.data().credits === 'number') ? snap.data().credits : 0;
        if (current < amt) throw new Error('Crédito insuficiente.');
        const updated = Math.round((current - amt) * 100) / 100;
        tx.set(ref, { credits: updated }, { merge: true });
        return updated;
      });
      res.status(200).json({ ok: true, newCredits });
    } catch (err) {
      console.error('consumeClientCredits falhou:', err);
      res.status(400).json({ ok: false, error: err.message });
    }
  });
});

/**
 * Recompensa o convite de amigo (5€ para cada lado) assim que o AMIGO
 * CONVIDADO conclui a sua PRIMEIRA viagem paga — nunca no registo, para não
 * ser possível ganhar crédito com contas falsas sem viagens reais.
 *
 * Dispara quando rides/{rideId} passa a status:'completed' (ver
 * markTripComplete em luxdriver-motorista.html). Regras aplicadas:
 *   - só recompensa se for mesmo a 1ª corrida concluída deste cliente;
 *   - só recompensa se o cliente tiver sido convidado (referredBy) e ainda
 *     não tiver sido recompensado antes (referralRewarded === false);
 *   - o convidador só pode ser recompensado por, no máximo, 2 amigos
 *     (referralCount < 2) — limite pedido explicitamente pelo negócio.
 * Tudo corre numa transação Firestore para evitar corridas em paralelo a
 * ultrapassarem o limite de 2 amigos.
 */
exports.rewardReferralOnFirstRide = onDocumentUpdated('rides/{rideId}', async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!after || !before) return;
  if (before.status === 'completed' || after.status !== 'completed') return;
  if (!after.clientEmail) return;

  const db = admin.firestore();
  const referredId = clientDocIdFromEmail(after.clientEmail);
  const referredRef = db.collection('clients').doc(referredId);

  try {
    const referredSnap = await referredRef.get();
    if (!referredSnap.exists) return;
    const referred = referredSnap.data();
    if (!referred.referredBy || referred.referralRewarded !== false) return;

    // Confirma que esta é mesmo a 1ª viagem CONCLUÍDA deste cliente.
    const completedRides = await db.collection('rides')
      .where('clientEmail', '==', after.clientEmail)
      .where('status', '==', 'completed')
      .get();
    if (completedRides.size !== 1) return;

    const referrerRef = db.collection('clients').doc(referred.referredBy);
    await db.runTransaction(async (tx) => {
      const [referrerSnap, referredSnap2] = await Promise.all([tx.get(referrerRef), tx.get(referredRef)]);
      if (!referrerSnap.exists) return;
      const referrer = referrerSnap.data();
      const referredNow = referredSnap2.data();
      if (referredNow.referralRewarded !== false) return; // já recompensado (concorrência)
      const referralCount = typeof referrer.referralCount === 'number' ? referrer.referralCount : 0;
      if (referralCount >= 2) return; // limite de 2 amigos por conta

      const referrerCredits = typeof referrer.credits === 'number' ? referrer.credits : 0;
      const referredCredits = typeof referredNow.credits === 'number' ? referredNow.credits : 0;
      tx.set(referrerRef, {
        credits: Math.round((referrerCredits + 5) * 100) / 100,
        referralCount: referralCount + 1
      }, { merge: true });
      tx.set(referredRef, {
        credits: Math.round((referredCredits + 5) * 100) / 100,
        referralRewarded: true
      }, { merge: true });
    });
  } catch (err) {
    console.error('rewardReferralOnFirstRide falhou:', err);
  }
});

/**
 * ===================== DESPACHO SERVIDOR DE RESERVAS =====================
 * Rede de segurança server-side para o despacho de reservas ("Reserva um
 * transfer"). O despacho normal (ativar uma reserva quando se aproxima a
 * hora marcada, e avançar a oferta de motorista em motorista) corre no
 * cliente (ver checkMyScheduledRides/advanceRideOffer em lux-cliente.html)
 * enquanto a app do PASSAGEIRO está aberta. Se o passageiro fechar a app
 * antes da hora da reserva chegar, isso nunca acontece e o motorista nunca
 * recebe o alerta — este era o bug reportado ("motorista ainda não recebe
 * alerta de pedido de reserva"). Esta função corre a cada minuto e replica
 * exatamente a mesma lógica do cliente, para que a reserva seja despachada
 * mesmo com a app do cliente fechada.
 */
const MAX_MATCH_RADIUS_KM = 20; // igual ao valor usado em lux-cliente.html
const SCHEDULE_ACTIVATION_WINDOW_MINUTES = 30; // igual ao valor usado em lux-cliente.html
const OFFER_WINDOW_MS = 16000; // igual ao valor usado em lux-cliente.html

function normalizeDistrictNameServer(name) {
  if (!name) return null;
  return String(name)
    .toLowerCase()
    .replace(/^distrito\s+(de|do|da)\s+/i, '')
    .replace(/^regi[aã]o\s+aut[oó]noma\s+(de|do|da)\s+/i, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim();
}

function haversineKmServer(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v == null || Number.isNaN(v))) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function pickNextDriverCandidateServer(db, pickupLat, pickupLng, excludeIds, districtFilter) {
  if (districtFilter) {
    try {
      const snap = await db.collection('driver_locations').where('online', '==', true).get();
      const candidates = [];
      snap.forEach((doc) => {
        if (excludeIds.has(doc.id)) return;
        const d = doc.data();
        if (!d.district || normalizeDistrictNameServer(d.district) !== districtFilter) return;
        candidates.push(doc.id);
      });
      if (!candidates.length) return null;
      return candidates[Math.floor(Math.random() * candidates.length)];
    } catch (e) {
      console.warn('dispatchScheduledRides: falha ao procurar motoristas no distrito:', e);
      return null;
    }
  }
  if (pickupLat == null || pickupLng == null) return null;
  try {
    const snap = await db.collection('driver_locations').where('online', '==', true).get();
    let best = null, bestKm = Infinity;
    snap.forEach((doc) => {
      if (excludeIds.has(doc.id)) return;
      const d = doc.data();
      if (d.lat == null || d.lng == null) return;
      const km = haversineKmServer(pickupLat, pickupLng, d.lat, d.lng);
      if (km == null || km > MAX_MATCH_RADIUS_KM) return;
      if (km < bestKm) { bestKm = km; best = doc.id; }
    });
    return best;
  } catch (e) {
    console.warn('dispatchScheduledRides: falha ao procurar motoristas próximos:', e);
    return null;
  }
}

async function advanceRideOfferServer(db, rideId, rideData) {
  const ride = rideData;
  if (ride.status !== 'searching') return;
  const offered = new Set(ride.offeredDriverIds || []);
  const declined = new Set(ride.declinedDriverIds || []);
  const excluded = new Set([...offered, ...declined]);
  const districtFilter = ride.scheduledFor ? normalizeDistrictNameServer(ride.district) : null;
  let candidate = await pickNextDriverCandidateServer(db, ride.pickupLat, ride.pickupLng, excluded, districtFilter);
  let didReset = false;
  if (!candidate && offered.size > 0) {
    didReset = true;
    candidate = await pickNextDriverCandidateServer(db, ride.pickupLat, ride.pickupLng, declined, districtFilter);
  }
  if (!candidate) return; // sem candidatos disponíveis agora; tenta de novo no próximo minuto
  const expiresAt = Date.now() + OFFER_WINDOW_MS;
  const update = {
    offerDriverId: candidate,
    offerExpiresAt: expiresAt,
    offeredDriverIds: didReset ? [candidate] : admin.firestore.FieldValue.arrayUnion(candidate),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  try {
    await db.collection('rides').doc(rideId).set(update, { merge: true });
  } catch (e) {
    console.warn('dispatchScheduledRides: falha ao atribuir motorista à corrida', rideId, e);
  }
}

/**
 * ===================== LUXTRANSLATOR (chat cliente ↔ motorista) =====================
 * Traduz automaticamente cada mensagem nova de rides/{rideId}/messages para o
 * idioma do OUTRO lado da conversa, e grava o resultado no próprio documento
 * da mensagem (translatedText/translatedLang). O frontend (lux-cliente.html
 * e luxdriver-motorista.html) mostra sempre o texto original, e por baixo,
 * se existir, a tradução — sem esconder nunca a mensagem tal como foi escrita.
 *
 * De onde vem cada idioma:
 *   - Cliente: campo clientLang gravado no documento da corrida na criação
 *     (currentLang da app cliente no momento do pedido).
 *   - Motorista: campo spokenLanguage em drivers/{driverId} — configurável
 *     em "Definições > Idioma que falo", DISTINTO do idioma da interface da
 *     app (que só traduz botões/labels e não diz nada sobre que língua o
 *     motorista efetivamente fala com o cliente).
 *
 * Usa as credenciais automáticas da Cloud Function (Application Default
 * Credentials) — não precisa de nenhuma chave de API: basta a Cloud
 * Translation API estar ativada no projeto Google Cloud (translate.googleapis.com).
 */
const translateClient = new Translate();
const LUXTRANSLATOR_SUPPORTED_LANGS = ['pt', 'en', 'es', 'fr', 'de'];
function luxTranslatorNormalizeLang(lang) {
  const l = String(lang || 'pt').toLowerCase().slice(0, 2);
  return LUXTRANSLATOR_SUPPORTED_LANGS.includes(l) ? l : 'pt';
}
exports.translateChatMessage = onDocumentCreated('rides/{rideId}/messages/{messageId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const msg = snap.data();
  if (!msg || !msg.text || msg.translatedText) return;
  const db = admin.firestore();
  const rideId = event.params.rideId;
  try {
    const rideSnap = await db.collection('rides').doc(rideId).get();
    const ride = rideSnap.exists ? rideSnap.data() : {};
    const clientLang = luxTranslatorNormalizeLang(ride.clientLang);
    let driverLang = 'pt';
    const driverId = ride.driverId;
    if (driverId) {
      const driverSnap = await db.collection('drivers').doc(driverId).get();
      if (driverSnap.exists) driverLang = luxTranslatorNormalizeLang(driverSnap.data().spokenLanguage);
    }
    const sourceLang = msg.sender === 'driver' ? driverLang : clientLang;
    const targetLang = msg.sender === 'driver' ? clientLang : driverLang;
    if (!targetLang || sourceLang === targetLang) return;
    const [translation] = await translateClient.translate(msg.text, { from: sourceLang, to: targetLang });
    if (translation && translation !== msg.text) {
      await snap.ref.set({ translatedText: translation, translatedLang: targetLang }, { merge: true });
    }
  } catch (e) {
    console.warn('translateChatMessage: falha ao traduzir mensagem da corrida', rideId, e);
  }
});

/* ---- Página pública de tracking (acompanhar.html) ------------------------
 * O documento rides/{rideId} contém dados sensíveis do cliente e do
 * motorista (telefone, email, preço, paymentIntentId), por isso NÃO pode
 * ter leitura pública direta. Em vez disso, esta função espelha apenas os
 * campos necessários para a página pública de acompanhamento (sem login)
 * num documento separado, public_tracking/{rideId}, que tem regra de
 * leitura pública (apenas "get" pelo ID da própria corrida — nunca "list").
 * O ID da corrida funciona como o "token" de acesso ao link partilhado,
 * exatamente como no botão "Partilhar" do Uber/Bolt.
 */
function mirrorPublicTracking(rideId, ride) {
  if (!rideId || !ride) return Promise.resolve();
  const db = admin.firestore();
  const safe = {
    status: ride.status || null,
    driverName: ride.driverName || null,
    driverPhotoUrl: ride.driverPhotoUrl || null,
    driverId: ride.driverId || null,
    vehicleBrand: ride.vehicleBrand || null,
    vehicleModel: ride.vehicleModel || null,
    vehicleColor: ride.vehicleColor || null,
    vehiclePlate: ride.vehiclePlate || null,
    vehicleName: ride.vehicleName || null,
    origin: ride.origin || null,
    destination: ride.destination || null,
    pickupLat: (typeof ride.pickupLat === 'number') ? ride.pickupLat : null,
    pickupLng: (typeof ride.pickupLng === 'number') ? ride.pickupLng : null,
    dropoffLat: (typeof ride.dropoffLat === 'number') ? ride.dropoffLat : null,
    dropoffLng: (typeof ride.dropoffLng === 'number') ? ride.dropoffLng : null,
    stops: Array.isArray(ride.stops) ? ride.stops.map(function (s) {
      return { address: s.address || '', lat: s.lat || null, lng: s.lng || null };
    }) : [],
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  return db.collection('public_tracking').doc(rideId).set(safe, { merge: true })
    .catch(function (e) { console.warn('mirrorPublicTracking: falha ao gravar', rideId, e); });
}
exports.mirrorPublicTrackingOnCreate = onDocumentCreated('rides/{rideId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  await mirrorPublicTracking(event.params.rideId, snap.data());
});
exports.mirrorPublicTrackingOnUpdate = onDocumentUpdated('rides/{rideId}', async (event) => {
  const after = event.data && event.data.after;
  if (!after) return;
  await mirrorPublicTracking(event.params.rideId, after.data());
});

exports.dispatchScheduledRides = onSchedule('every 1 minutes', async () => {
  const db = admin.firestore();
  const now = Date.now();

  // 1) Ativa reservas cuja hora marcada já esteja dentro da janela de
  //    ativação — mesmo critério usado em checkMyScheduledRides() no cliente.
  try {
    const limitTs = admin.firestore.Timestamp.fromDate(new Date(now + SCHEDULE_ACTIVATION_WINDOW_MINUTES * 60000));
    const scheduledSnap = await db.collection('rides').where('status', '==', 'scheduled').get();
    for (const doc of scheduledSnap.docs) {
      const data = doc.data();
      const sf = data.scheduledFor;
      const sfMillis = sf && sf.toMillis ? sf.toMillis() : null;
      if (sfMillis == null || sfMillis > limitTs.toMillis()) continue;
      try {
        await doc.ref.set({ status: 'searching', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        const freshSnap = await doc.ref.get();
        if (freshSnap.exists) await advanceRideOfferServer(db, doc.id, freshSnap.data());
      } catch (e) {
        console.warn('dispatchScheduledRides: falha ao ativar reserva', doc.id, e);
      }
    }
  } catch (e) {
    console.error('dispatchScheduledRides: falha ao procurar reservas por ativar:', e);
  }

  // 2) Avança corridas já em despacho ('searching') cuja oferta ao motorista
  //    atual expirou (ou nunca chegou a ser feita) — rede de segurança para
  //    quando a app do cliente está fechada durante o despacho.
  try {
    const searchingSnap = await db.collection('rides').where('status', '==', 'searching').get();
    for (const doc of searchingSnap.docs) {
      const data = doc.data();
      const stillNeedsOffer = !data.offerDriverId || !data.offerExpiresAt || data.offerExpiresAt <= now;
      if (!stillNeedsOffer) continue;
      await advanceRideOfferServer(db, doc.id, data);
    }
  } catch (e) {
    console.error('dispatchScheduledRides: falha ao avançar ofertas pendentes:', e);
  }
});
