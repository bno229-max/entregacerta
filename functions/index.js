/**
 * Notificação push real — Certify Delivery
 * -------------------------------------------------------------
 * Dispara sempre que uma entrega é CRIADA já atribuída a um motorista,
 * ou quando o campo motoristaId muda (reatribuição).
 * Envia via Firebase Cloud Messaging para o token salvo em
 * usuarios/{motoristaId}.fcmToken (o app do motorista salva esse
 * token assim que ele autoriza notificações no navegador/celular).
 */
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

async function enviarNotificacao(motoristaId, titulo, corpo) {
  if (!motoristaId) return;
  const doc = await db.collection("usuarios").doc(motoristaId).get();
  if (!doc.exists) return;
  const token = doc.data().fcmToken;
  if (!token) return; // motorista ainda não autorizou notificações neste aparelho

  try {
    await messaging.send({
      token,
      notification: { title: titulo, body: corpo },
      webpush: { fcmOptions: { link: "/" } },
    });
    console.log(`Notificação enviada para ${motoristaId}: ${titulo}`);
  } catch (err) {
    console.error("Erro ao enviar notificação:", err);
    if (err.code === "messaging/registration-token-not-registered") {
      // Token antigo/inválido — remove para não tentar de novo
      await db.collection("usuarios").doc(motoristaId).update({
        fcmToken: admin.firestore.FieldValue.delete(),
      });
    }
  }
}

// Nova entrega já criada com motorista definido
exports.notificarNovaEntrega = onDocumentCreated("entregas/{entregaId}", async (event) => {
  const entrega = event.data.data();
  if (!entrega || !entrega.motoristaId) return;
  await enviarNotificacao(
    entrega.motoristaId,
    "Nova entrega atribuída",
    `NF ${entrega.notaFiscal} · ${entrega.clienteNome || "Cliente"}`
  );
});

// Reatribuição: motoristaId mudou de um motorista para outro
exports.notificarReatribuicao = onDocumentUpdated("entregas/{entregaId}", async (event) => {
  const antes = event.data.before.data();
  const depois = event.data.after.data();
  if (!depois || !antes) return;
  if (antes.motoristaId === depois.motoristaId) return; // não mudou, ignora

  await enviarNotificacao(
    depois.motoristaId,
    "Entrega atribuída a você",
    `NF ${depois.notaFiscal} · ${depois.clienteNome || "Cliente"}`
  );
});
