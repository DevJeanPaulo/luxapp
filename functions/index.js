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
