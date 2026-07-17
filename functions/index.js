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
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

const LIMITES_MOTORISTAS = { starter: 3, growth: 5, business: 10 };
const LIMITES_ENTREGAS_MES = { starter: 1000, growth: 1500, business: 2000 };

/**
 * Confirma que quem chamou é um admin autenticado e devolve o empresaId dele.
 * Lança erro se não for admin — usado nas duas functions abaixo.
 */
async function exigirAdmin(auth) {
  if (!auth) throw new HttpsError("unauthenticated", "É preciso estar logado.");
  const perfil = await db.collection("usuarios").doc(auth.uid).get();
  if (!perfil.exists || perfil.data().role !== "admin") {
    throw new HttpsError("permission-denied", "Apenas administradores podem fazer isso.");
  }
  return { empresaId: perfil.data().empresaId || auth.uid };
}

/**
 * Cria o login (Firebase Authentication) + os documentos do motorista.
 * O limite de motoristas do plano é checado aqui, do lado do servidor —
 * não dá pra burlar entrando direto no console do navegador.
 */
exports.criarMotorista = onCall({ region: "southamerica-east1" }, async (request) => {
  try {
    const { empresaId } = await exigirAdmin(request.auth);
    const { nome, cpf, rg, telefone, email, placa, modelo, status, senha } = request.data || {};

    if (!nome || !cpf) throw new HttpsError("invalid-argument", "Informe nome e CPF.");
    if (!email) throw new HttpsError("invalid-argument", "Informe o e-mail do motorista.");
    if (!senha || senha.length < 6) throw new HttpsError("invalid-argument", "A senha precisa ter pelo menos 6 caracteres.");

    const configDoc = await db.collection("config").doc(empresaId).get();
    const planoNome = configDoc.exists ? configDoc.data().planoNome : null;
    const limite = LIMITES_MOTORISTAS[planoNome];
    if (limite) {
      const existentes = await db.collection("motoristas").where("empresaId", "==", empresaId).get();
      if (existentes.size >= limite) {
        throw new HttpsError("resource-exhausted", `Seu plano atual permite no máximo ${limite} motoristas cadastrados.`);
      }
    }

    let userRecord;
    try {
      userRecord = await admin.auth().createUser({ email, password: senha, displayName: nome });
    } catch (err) {
      console.error("Erro ao criar usuário no Authentication:", err);
      const mensagens = {
        "auth/email-already-exists": "Este e-mail já está cadastrado em outro acesso.",
        "auth/invalid-email": "O e-mail informado é inválido.",
        "auth/invalid-password": "A senha precisa ter pelo menos 6 caracteres.",
        "auth/weak-password": "A senha é muito fraca. Use uma senha mais forte.",
      };
      const mensagem = mensagens[err.code] || ("Erro ao criar login (" + (err.code || "motivo desconhecido") + "): " + err.message);
      // "invalid-argument" (em vez de "internal") faz o Firebase mostrar essa mensagem real pro usuário,
      // já que o código "internal" é tratado como sensível e o Firebase esconde os detalhes por padrão.
      throw new HttpsError("invalid-argument", mensagem);
    }

    const motoristaUid = userRecord.uid;
    try {
      await Promise.all([
        db.collection("usuarios").doc(motoristaUid).set({ nome, email, role: "motorista", telefone: telefone || null, empresaId }),
        db.collection("motoristas").doc(motoristaUid).set({ nome, cpf, rg: rg || null, telefone: telefone || null, email, placa: placa || null, modelo: modelo || null, status: status || "ativo", empresaId }),
      ]);
    } catch (err) {
      console.error("Erro ao salvar dados do motorista no Firestore:", err);
      // O login já foi criado — desfaz, para não deixar um acesso "fantasma" sem cadastro.
      await admin.auth().deleteUser(motoristaUid).catch(() => {});
      throw new HttpsError("invalid-argument", "Erro ao salvar os dados do motorista: " + err.message);
    }

    return { uid: motoristaUid };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error("Erro inesperado em criarMotorista:", err);
    throw new HttpsError("invalid-argument", "Erro inesperado: " + (err.message || String(err)));
  }
});

/**
 * Cria uma ou mais entregas (notas fiscais) de uma vez.
 * O limite mensal de entregas do plano é checado aqui, do lado do servidor.
 */
exports.criarEntregas = onCall({ region: "southamerica-east1" }, async (request) => {
  try {
    const { empresaId } = await exigirAdmin(request.auth);
    const { notas, clienteId, clienteNome, clienteEndereco, clienteCidade, clienteTelefone, motoristaId, motoristaNome, status, observacoes, dataAgendadaMs } = request.data || {};

    if (!Array.isArray(notas) || !notas.length) throw new HttpsError("invalid-argument", "Informe ao menos uma nota fiscal.");
    if (!clienteId || !motoristaId) throw new HttpsError("invalid-argument", "Selecione cliente e motorista.");

    const configDoc = await db.collection("config").doc(empresaId).get();
    const planoNome = configDoc.exists ? configDoc.data().planoNome : null;
    const limite = LIMITES_ENTREGAS_MES[planoNome];
    if (limite) {
      const agora = new Date();
      const todasDaEmpresa = await db.collection("entregas").where("empresaId", "==", empresaId).get();
      const contagemMes = todasDaEmpresa.docs.filter((d) => {
        const dt = d.data().dataAgendada;
        if (!dt || !dt.toDate) return false;
        const data = dt.toDate();
        return data.getMonth() === agora.getMonth() && data.getFullYear() === agora.getFullYear();
      }).length;
      if (contagemMes + notas.length > limite) {
        throw new HttpsError("resource-exhausted", `Seu plano atual permite no máximo ${limite} entregas por mês (você já tem ${contagemMes} este mês).`);
      }
    }

    const dataAgendada = dataAgendadaMs ? admin.firestore.Timestamp.fromMillis(dataAgendadaMs) : admin.firestore.FieldValue.serverTimestamp();
    const batch = db.batch();
    const idsCriados = [];
    notas.forEach((n) => {
      const ref = db.collection("entregas").doc();
      idsCriados.push(ref.id);
      batch.set(ref, {
        empresaId,
        notaFiscal: n.nf,
        serie: n.serie || "1",
        clienteId, clienteNome, clienteEndereco: clienteEndereco || null, clienteCidade: clienteCidade || null, clienteTelefone: clienteTelefone || null,
        motoristaId, motoristaNome,
        status: status || "aguardando",
        observacoes: observacoes || "",
        dataAgendada,
        timeline: [{ status: status || "aguardando", data: new Date() }],
      });
    });
    await batch.commit();
    return { ids: idsCriados, count: notas.length };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error("Erro inesperado em criarEntregas:", err);
    throw new HttpsError("invalid-argument", "Erro inesperado: " + (err.message || String(err)));
  }
});

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
exports.notificarNovaEntrega = onDocumentCreated({ document: "entregas/{entregaId}", region: "southamerica-east1" }, async (event) => {
  const entrega = event.data.data();
  if (!entrega || !entrega.motoristaId) return;
  await enviarNotificacao(
    entrega.motoristaId,
    "Nova entrega atribuída",
    `NF ${entrega.notaFiscal} · ${entrega.clienteNome || "Cliente"}`
  );
});

// Reatribuição: motoristaId mudou de um motorista para outro
exports.notificarReatribuicao = onDocumentUpdated({ document: "entregas/{entregaId}", region: "southamerica-east1" }, async (event) => {
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
