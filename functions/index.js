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
