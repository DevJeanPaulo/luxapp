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
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const Stripe = require('stripe');
const cors = require('cors')({ origin: true });

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
