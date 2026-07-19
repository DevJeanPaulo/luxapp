# Guia de configuração — Stripe + Firebase (Lux / LuxDriver)

Este ficheiro explica o que precisas de preencher para ativar pagamentos reais (Stripe) nos dois apps. O **Firebase já está configurado e ativo** (ver secção 1). Sem os passos do Stripe, os apps continuam a funcionar normalmente em **modo demonstração** para pagamentos (aprovação simulada, sem cobrar ninguém).

## 1. Firebase — já configurado ✅

Projeto real criado e ligado aos 4 ficheiros do projeto:

- **Projeto:** Lux Transfers (`lux-transfers-3327d`)
- **Firestore:** ativado, região `eur3 (Europe)`. Regras fechadas por predefinição, com **uma exceção**: a coleção `driver_locations` está aberta a leitura/escrita pública (ver secção 1b) — todo o resto continua bloqueado.
- **Cloud Messaging (FCM):** ativado, com chave VAPID gerada
- **Apps Web registadas:** "Lux Cliente Web" e "LuxDriver Web" (cada uma com o seu próprio `appId`, para poderes distinguir a origem dos pushes/eventos no futuro)

A configuração real já está aplicada em:

- `lux-cliente.html` — constante `FIREBASE_CONFIG` e `FIREBASE_VAPID_KEY`
- `luxdriver-motorista.html` — constante `FIREBASE_CONFIG` e `FIREBASE_VAPID_KEY`
- `sw-lux.js` — objeto passado a `firebase.initializeApp(...)`
- `sw-luxdriver.js` — objeto passado a `firebase.initializeApp(...)`
- `luxtransfers-app-prototipo.html` — ficheiro combinado (fonte de verdade), mesma configuração

O alternador **Notificações push** nas Definições de cada app já pede permissão ao browser a sério e regista o dispositivo (o token FCM continua a ir apenas para o `console.log`, ver nota abaixo).

> O token de cada dispositivo (`FCM token`) fica apenas no `console.log` por agora — no `functions/index.js` tens um exemplo de como guardar esse token em `users/{uid}.fcmToken` e usá-lo para notificar o utilizador certo. Vais precisar de ligar isso ao teu sistema de contas real (idealmente Firebase Authentication, substituindo o login simulado que existe hoje nos apps). Nesse momento também vais querer apertar as regras do Firestore (atualmente fechadas a qualquer leitura/escrita direta do cliente).

> **Nota de segurança:** o projeto Firebase pré-existente "luxtransfersgemini" (e a respetiva conta de Analytics "LuxTransfers Travel Solutions") não foi tocado — este novo projeto "Lux Transfers" é totalmente independente.

## 1b. Google Maps + acompanhamento ao vivo — já configurado ✅

A tua chave da Maps JavaScript API já está aplicada em `lux-cliente.html`, `luxdriver-motorista.html`, `admin-panel.html` e no ficheiro combinado. Substitui o mapa em grelha simulado por um mapa real do Google (com rota real via Directions API) nos ecrãs de pedido/viagem dos dois apps. Se a API falhar (offline, chave inválida, bloqueada), os apps caem automaticamente de volta no mapa simulado — nada parte.

**Como funciona o acompanhamento ao vivo:**
1. Quando o motorista fica **online** no LuxDriver, o browser pede permissão de localização e começa a gravar a posição real (lat/lng) no Firestore, na coleção `driver_locations`, a cada poucos segundos.
2. O separador **"🔴 Ao vivo"** no `admin-panel.html` ouve essa coleção em tempo real (Firestore `onSnapshot`) e mostra todos os motoristas online num mapa, com uma lista ao lado.
3. Quando o motorista fica offline (ou termina sessão), o marcador desaparece do mapa do admin.

**Coisas a saber antes de ires para produção:**
- **A chave da Maps API ainda não está restringida.** Vai a [Google Cloud Console → Credenciais](https://console.cloud.google.com/apis/credentials) e limita esta chave por "referenciadores HTTP" (o teu domínio da Hostinger) — caso contrário qualquer pessoa pode usá-la e gerar custos na tua conta.
- **A regra do Firestore para `driver_locations` está aberta a qualquer leitura/escrita**, porque os apps ainda usam um login simulado (não Firebase Authentication real). Isto é aceitável para uma demonstração, mas antes de lançares a app a sério deves: (1) ligar Firebase Authentication real, e (2) trocar a regra para só permitir que cada motorista escreva o seu próprio documento (`allow write: if request.auth.uid == driverId`).
- A ativação da **Maps JavaScript API**, **Directions API** e **Geocoding API** têm de estar ligadas no teu projeto do Google Cloud associado à chave — se o mapa não aparecer, confirma isso primeiro em [Google Cloud Console → APIs ativadas](https://console.cloud.google.com/apis/dashboard).

## 2. Stripe — a tua conta separada

Confirma que a conta Stripe que vais criar está em modo **de teste** até validares tudo.

1. Na [dashboard da Stripe](https://dashboard.stripe.com/apikeys), copia a **chave publicável** (`pk_test_...` ou `pk_live_...`) e a **chave secreta** (`sk_test_...` ou `sk_live_...`).
2. A chave **publicável** vai no frontend — substitui `STRIPE_PUBLISHABLE_KEY` em `lux-cliente.html` e `luxdriver-motorista.html`.
3. A chave **secreta** nunca vai para o frontend — fica só no backend (Cloud Functions), configurada como secret:

   ```
   cd functions
   npm install
   firebase functions:secrets:set STRIPE_SECRET_KEY
   ```

   (cola a chave `sk_...` quando pedido)

4. Faz o deploy das funções:

   ```
   firebase deploy --only functions
   ```

5. Copia o URL gerado para `createPaymentIntent` e substitui `CREATE_PAYMENT_INTENT_URL` em `lux-cliente.html` e `luxdriver-motorista.html`.

Onde isto é usado nos apps:
- **Lux (cliente):** ecrã "Concluir e pagar" no fim da viagem.
- **LuxDriver:** botão "Recarregar saldo" (comissão).

## 3. functions/index.js — o que já vem pronto

- `createPaymentIntent` — cria o pagamento Stripe e devolve o `clientSecret` ao frontend.
- `onRideStatusChanged` — exemplo de como disparar um push automático quando o estado de uma viagem muda no Firestore (`rides/{rideId}.status`). Os nomes de coleções/campos são ilustrativos — ajusta ao teu modelo de dados assim que ligares os apps a uma base de dados real (hoje os apps não têm backend de dados, só o fluxo simulado).

## 4. Hospedagem na Hostinger

Podes fazer upload de tudo (`lux-cliente.html`, `luxdriver-motorista.html`, `lux-manifest.json`, `luxdriver-manifest.json`, `sw-lux.js`, `sw-luxdriver.js`, pasta `icons/`) para a mesma pasta no teu domínio — os caminhos são todos relativos. A pasta `functions/` **não** vai para a Hostinger: faz deploy dela separadamente para o Firebase com `firebase deploy --only functions`.

A instalação "Adicionar ao ecrã principal" e as notificações push só funcionam em **HTTPS** — a Hostinger já fornece isso por predefinição.

## 5. Testar sem a chave Stripe configurada

Não precisas de preencher o Stripe já — os apps detetam automaticamente que `STRIPE_PUBLISHABLE_KEY` ainda tem `TODO` e caem em modo demonstração só para pagamentos: o pagamento "aprova-se" sozinho ao fim de ~1 segundo. As notificações push, por outro lado, já usam o Firebase real configurado na secção 1. Isto permite continuar a mostrar/testar o fluxo completo enquanto configuras a conta Stripe com calma.
