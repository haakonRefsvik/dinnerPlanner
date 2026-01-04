require("dotenv").config();

const TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

const { Client, GatewayIntentBits } = require("discord.js");
const cron = require("node-cron");
const { dinnerIdeas } = require("./utils/dinnerIdeas");

const EMOJI = "👍";
const REQUIRED_COUNT = 2;
const dinnerEaters = new Map();
const dinnerMakers = new Map();
const testing = false;
let askingInProgress = false;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent, // needed to track messages in channel
  ],
  partials: ["MESSAGE", "CHANNEL", "REACTION"],
});

let activeUsers = new Map(); // Track users who send messages
let userMap = new Map(); // user.username: user.id

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);

  if (testing) {
    cron.schedule("* * * * *", async () => {
      try {
        await askForDinner();
      } catch (err) {
        console.error("First msg failed");
      }
    });
  } else {
    cron.schedule("0 12 * * *", async () => {
      try {
        await askForDinner();
      } catch (err) {
        console.error("First msg failed");
      }
    });
    cron.schedule("0 15 * * *", async () => {
      try {
        await reminder();
      } catch (err) {
        console.error("Second msg failed");
      }
    });
  }
});

async function retry(
  fn,
  { retries = 3, delayMs = 2_000, name = "operation" } = {}
) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.error(
        `${name} failed (attempt ${attempt}/${retries}):`,
        err.message ?? err
      );

      if (attempt < retries) {
        await new Promise((res) => setTimeout(res, delayMs));
      }
    }
  }

  throw lastError;
}

async function reminder() {
  const channel = await retry(() => client.channels.fetch(CHANNEL_ID), {
    retries: 3,
    delayMs: 10_000,
    name: "fetch channel",
  });

  let msg = `@everyone 💬\nHusk å respondere innen 16:00 🧑‍🍳`;
  await channel.send(msg);
}

async function askForDinner() {
  if (askingInProgress) {
    console.warn("Dinner already in progress, skipping");
    return;
  }
  askingInProgress = true;

  const channel = await retry(() => client.channels.fetch(CHANNEL_ID), {
    retries: 3,
    delayMs: 10_000,
    name: "fetch channel",
  });

  let msg = `@everyone 💬\nSend en melding (eller reager på denne) innen 16:00 ⏰ for å få middag`;
  msg += "\n- Hvis du vil ha, men ikke kan lage -> skriv '0'";
  msg += "\n- Hvis du gjerne vil lage -> skriv '1'";
  msg += "\n- Hvis du vil ha trekning -> skriv alt annet";

  const message = await retry(() => channel.send(msg), {
    retries: 3,
    delayMs: 10_000,
    name: "send askForDinner message",
  });
  await message.react(EMOJI);
  activeUsers.clear();

  // Beregn millisekunder til kl 16:00
  const now = new Date();
  const cutoffTime = new Date();
  cutoffTime.setHours(16, 0, 0, 0); // 16:00:00.000 i dag
  let msUntilCutoff = cutoffTime.getTime() - now.getTime();
  if (msUntilCutoff < 0) msUntilCutoff += 24 * 60 * 60 * 1000; // Hvis etter 16, gå til neste dag
  if (testing) msUntilCutoff = 10 * 1000; // 10 sec for testing

  // Collector for meldinger fram til cutoff
  const messageCollector = channel.createMessageCollector({
    filter: (msg) => !msg.author.bot,
    time: msUntilCutoff,
  });

  messageCollector.on("collect", (msg) => {
    activeUsers.set(msg.author.id, msg.content.trim());
  });

  // Etter cutoff, sjekk resultater
  setTimeout(() => checkResults(channel, message), msUntilCutoff);
}

function getKD(name) {
  const eaters = dinnerEaters.get(name) ?? 1;
  const makers = dinnerMakers.get(name) ?? 0;
  return makers / eaters;
}

function findChef(todaysGuests, cannotMake, canMake) {
  // add the eaters and makers
  for (const user of todaysGuests) {
    dinnerMakers.set(user, dinnerMakers.get(user) ?? 0);
    dinnerEaters.set(user, (dinnerEaters.get(user) ?? 0) + 1); // add the eaters
  }
  // increment the makers
  for (const user of canMake) {
    if (!user) continue;
    console.log(user + " er frivillig!");
    dinnerMakers.set(user, (dinnerMakers.get(user) ?? 0) + 1); // add the makers
  }
  if (canMake.length > 0) {
    return canMake;
  }
  console.log("ingen frivillige, trekker lodd");

  /** @type {string[]} */
  const sortedGuests = todaysGuests.filter((g) => !cannotMake.includes(g));
  if (sortedGuests.length === 0) {
    // if no makers, there should be no eaters either
    for (userId of todaysGuests) {
      dinnerEaters.set(userId, dinnerEaters.get(userId) - 1);
    }
    return [];
  }
  sortedGuests.sort((a, b) => getKD(a) - getKD(b)); // sort based on KD
  const picked = sortedGuests[0];
  dinnerMakers.set(picked, dinnerMakers.get(picked) + 1);
  return [picked]; // the guest with the lowest KD should make
}

// logging for testing purposes
function log(canMake, cannotMake, chefs) {
  if (testing) {
    for (const [key, value] of dinnerEaters) {
      console.log(`${key} have eaten ${value} times`);
    }
    for (const [key, value] of dinnerMakers) {
      console.log(`${key} have made ${value} times`);
    }
    console.log("cannot make: " + cannotMake);
    console.log("can make: " + canMake);
    console.log("chefs: " + chefs.join(", "));
    for (const [key, _] of dinnerEaters) {
      console.log("KD " + key + ": " + getKD(key));
    }
  }
}

async function checkResults(channel, botMessage) {
  try {
    if (!botMessage) return;

    // Fetch reactions
    const message = await retry(() => channel.messages.fetch(botMessage.id), {
      name: "fetch bot message",
    });
    const reaction = message.reactions.cache.get(EMOJI);

    // Users who reacted
    /** @type {string []} */
    let reactedUsers = [];
    if (reaction) {
      const users = await retry(() => reaction.users.fetch(), {
        name: "fetch reaction users",
      });

      reactedUsers = users.filter((u) => !u.bot).map((u) => `${u.username}`);
      reactedUsers.forEach((u) => userMap.set(u.username, u.id));
    }

    const cannotMake = [];
    const canMake = [];
    // Users who sent messages
    const sentUsers = [];
    for (const [userId, content] of activeUsers) {
      const user = await client.users.fetch(userId);
      userMap.set(user.username, user.id);
      sentUsers.push(`${user.username}`);
      /** @type {string} */
      const c = content;
      if (c.includes("1")) {
        canMake.push(user.username);
      }
      if (c.includes("0")) {
        cannotMake.push(user.username);
      }
    }

    // Combine counts
    const allParticipantSet = new Set([...sentUsers, ...reactedUsers]); // remove dupes
    const allParticipantList = [...allParticipantSet];
    const total = allParticipantList.length;
    // Send summary to channel
    const chefs = findChef(allParticipantList, cannotMake, canMake);
    const mentions = chefs
      .map((username) => {
        const id = userMap.get(username);
        return id ? `<@${id}>` : username;
      })
      .join(", ");

    log(canMake, cannotMake, chefs); // log for testing

    const randomDinner =
      dinnerIdeas[Math.floor(Math.random() * dinnerIdeas.length)];

    let dinnerSummary = `@everyone 🍽️ Dagens middag:`;
    dinnerSummary += `\n- 🤑 Gjester: ${allParticipantList.join(", ")}`;
    dinnerSummary += `\n- 🧑‍🍳 Dagens chef(s): ${mentions}`;
    dinnerSummary += `\n- 🍳 Middagsforslag: ${randomDinner}`;

    if (testing || (total >= REQUIRED_COUNT && chefs.length > 0)) {
      await retry(() => channel.send(dinnerSummary), {
        name: "send dinner summary",
      });
    } else if (chefs.length === 0) {
      await retry(
        () => channel.send(`@everyone 😔 Ingen kunne lage middag idag`),
        { name: "send dinner summary" }
      );
    } else {
      await retry(() => channel.send(`@everyone 😔 Kun en skal ha middag`), {
        name: "send dinner summary",
      });
    }
  } catch (err) {
    console.error("checkResults failed:", err);
  } finally {
    askingInProgress = false;
  }
}

client.login(TOKEN);
