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

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);

  if (testing) {
    cron.schedule("* * * * *", async () => {
      askForDinner();
    });
  } else {
    cron.schedule("0 12 * * *", async () => {
      askForDinner();
    });
    cron.schedule("0 15 * * *", async () => {
      reminder();
    });
  }
});

async function reminder() {
  const channel = await client.channels.fetch(CHANNEL_ID);
  let msg = `@everyone 💬\nHusk å respondere innen 16:00 🧑‍🍳`;
  await channel.send(msg);
}

async function askForDinner() {
  const channel = await client.channels.fetch(CHANNEL_ID);
  let msg = `@everyone 💬\nSend en melding (eller reager på denne) innen 16:00 ⏰ for å få middag`;
  msg += "\n- Hvis du vil ha, men ikke kan lage -> skriv '0'";
  msg += "\n- Hvis du gjerne vil lage -> skriv '1'";
  msg += "\n- Hvis du vil ha trekning -> skriv alt annet";

  const message = await channel.send(msg);
  await message.react(EMOJI);
  lastMessageId = message.id;
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
  if (!botMessage) return;

  // Fetch reactions
  const message = await channel.messages.fetch(botMessage.id);
  const reaction = message.reactions.cache.get(EMOJI);

  // Users who reacted
  /** @type {string []} */
  let reactedUsers = [];
  if (reaction) {
    const users = await reaction.users.fetch(); // fetch all users who reacted
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
    channel.send(dinnerSummary);
  } else if (chefs.length === 0) {
    channel.send(`@everyone 😔 Ingen kunne lage middag idag`);
  } else {
    channel.send(`@everyone 😔 Kun én eller ingen skal ha middag`);
  }
}

client.login(TOKEN);
