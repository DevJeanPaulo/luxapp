# Guia de configuração — Stripe + Firebase (Lux / LuxDriver)

Este ficheiro explica o que precisas de preencher para ativar pagamentos reais (Stripe) nos dois apps. O **Firebase já está configurado e ativo** (ver secção 1). Sem os passos do Stripe, os apps continuam a funcionar normalmente em **modo demonstração** para pagamentos (aprovação simulada, sem cobrar ninguém).

## 1. Firebase — já configurado ✅

Projeto real criado e ligado aos ficheiros do projeto:

- **Conta Google:** jn.paulo2020@gmail.com
- **Projeto:** Lux Transfers (`lux-transfers-47cb2`)
- **Firestore:** ativado, região `eur3 (Europe)`. Regras fechadas por predefinição, com **três exceções**: as coleções `driver_locations` e `rides`, e a subcoleção `rides/{rideId}/messages`, estão abertas a leitura/escrita pública (ver secções 1b, 1c e 1d) — todo o resto continua bloqueado.
- **Cloud Messaging (FCM):** ativado, com chave VAPID gerada
- **Apps Web registadas:** "Lux Cliente Web" e "LuxDriver Web" (cada uma com o seu próprio `appId`, para poderes distinguir a origem dos pushes/eventos no futuro)

A configuração real já está aplicada em:

- `lux-cliente.html` — constante `FIREBASE_CONFIG` e `FIREBASE_VAPID_KEY`
- `luxdriver-motorista.html` — constante `FIREBASE_CONFIG` e `FIREBASE_VAPID_KEY`
- `admin-panel.html` — constante `FIREBASE_CONFIG`
- `sw-lux.js` — objeto passado a `firebase.initializeApp(...)`
- `sw-luxdriver.js` — objeto passado a `firebase.initializeApp(...)`
- `luxtransfers-app-prototipo.html` — ficheiro combinado (fonte de verdade), mesma configuração
- `.firebaserc` — projeto por defeito para os comandos `firebase` (Cloud Functions)

O alternador **Notificações push** nas Definições de cada app já pede permissão ao browser a sério e regista o dispositivo (o token FCM continua a ir apenas para o `console.log`, ver nota abaixo).

> O token de cada dispositivo (`FCM token`) fica apenas no `console.log` por agora — no `functions/index.js` tens um exemplo de como guardar esse token em `users/{uid}.fcmToken` e usá-lo para notificar o utilizador certo. Vais precisar de ligar isso ao teu sistema de contas real (idealmente Firebase Authentication, substituindo o login simulado que existe hoje nos apps). Nesse momento também vais querer apertar as regras do Firestore (atualmente fechadas a qualquer leitura/escrita direta do cliente).

> **Nota de segurança:** os projetos Firebase pré-existentes "luxtransfersgemini"/"LuxTransfersGemini" (e a respetiva conta de Analytics "LuxTransfers Travel Solutions") não foram tocados — este projeto "Lux Transfers" é totalmente independente.
>
> **Nota sobre o projeto anterior:** este projeto substitui o anterior `lux-transfers-3327d` (conta jn.paulo@gmail.com), criado numa sessão anterior. Esse projeto antigo continua a existir no Firebase mas os apps já não apontam para ele — podes eliminá-lo manualmente na consola se não precisares dele, ou deixá-lo (não gera custos parado no plano gratuito).
>
> **Plano de faturação:** este projeto ainda está no plano gratuito Spark. Para usares a Cloud Function de pagamentos (secção 2), o Firebase exige o upgrade para o plano Blaze (pago-conforme-usas, com camada gratuita generosa) — isto aplica-se a qualquer conta/projeto, não é específico desta conta.

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

## 1c. Pedidos de viagem em tempo real — já configurado ✅

O cliente e o motorista agora comunicam de verdade através da coleção `rides` no Firestore — dá para testar o fluxo completo com dois telemóveis diferentes (um a correr `applux.luxtransfers.pt`, outro `motorista.luxtransfers.pt`).

**Como funciona:**
1. O cliente escolhe um veículo e confirma → cria um documento em `rides` com `status:'searching'`, origem, destino, nome/telefone do cliente e o preço escolhido.
2. Todos os motoristas online que estejam a ouvir essa coleção recebem o pedido em tempo real (o primeiro a aceitar "ganha" o pedido — os outros continuam a ver pedidos seguintes).
3. Cada ação do motorista (aceitar, chegou ao local, iniciar viagem, terminar viagem, cancelar) atualiza o campo `status` do documento, e o cliente reage a essas mudanças automaticamente (avança de ecrã, mostra o nome do motorista, mostra a tarifa real no resumo final).
4. Se o Firestore estiver indisponível (offline, chave por preencher), ambos os apps caem automaticamente no fluxo simulado que já existia — nada parte.

**Antes de ires para produção:** a regra da coleção `rides` está aberta a qualquer leitura/escrita, pelo mesmo motivo que `driver_locations` (sem Firebase Authentication real ligado ainda). Depois de ligares autenticação real, aperta esta regra para só permitir que o cliente crie/cancele os seus próprios pedidos e o motorista só edite pedidos que já aceitou.

## 1d. Chat em tempo real (chamada real + mensagens) — já configurado ✅

Os ícones 📞 e 💬 nos ecrãs de viagem (cliente e motorista) agora funcionam a sério:

- **Chamada (📞):** abre o marcador do telemóvel (`tel:`) com o número real da outra pessoa quando existe uma viagem real em curso, ou o número de demonstração caso contrário.
- **Chat (💬):** abre um ecrã de mensagens ligado à subcoleção `rides/{rideId}/messages` no Firestore, com `onSnapshot` para atualização em tempo real entre os dois dispositivos. Sem uma viagem real ativa, o chat mostra um aviso e fica bloqueado para escrita (não haveria ninguém do outro lado a receber a mensagem).

**Antes de ires para produção:** a regra da subcoleção `rides/{rideId}/messages` está aberta a qualquer leitura/escrita, pelo mesmo motivo e com a mesma recomendação das secções 1b/1c — depois de ligares Firebase Authentication real, aperta esta regra para só permitir leitura/escrita a quem participa nessa viagem (cliente ou motorista do documento `rides/{rideId}`).

## 2. Stripe — a tua conta separada (modo de teste)

- **Chave publicável (`pk_test_...`) — já aplicada ✅** em `lux-cliente.html`, `luxdriver-motorista.html` e no ficheiro combinado (constante `STRIPE_PUBLISHABLE_KEY`). Isto liga o Stripe.js no frontend, mas os pagamentos só ficam 100% reais depois de completares os passos 3-5 abaixo (a chave secreta e o deploy da função). Até lá, os apps continuam em modo demonstração para pagamentos.
- **Chave secreta (`sk_test_...`) — falta configurar**, de propósito: por segurança, não introduzo chaves secretas em ficheiros nem comandos por ti. Vais precisar de a colar tu mesmo no terminal, no passo 3.

1. Confirma que a conta Stripe está em modo **de teste** (interruptor "Modo de teste" no canto do dashboard) até validares tudo.
2. Já não precisas de repetir este passo — a chave publicável já está aplicada.
3. A chave **secreta** nunca vai para o frontend — fica só no backend (Cloud Functions), configurada como secret. Copia-a de [dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys) e corre:

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
