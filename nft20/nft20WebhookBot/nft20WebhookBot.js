const axios = require("axios");
const Discord = require("discord.js");
const client = new Discord.Client();
path = require("path");
require("dotenv").config({
  path: path.resolve(process.cwd(), "./.env"),
});

let _assets;
const GetAssets = async () => {
  const response = await axios.get(
    "https://raw.githubusercontent.com/verynifty/nft20-assets/master/assets.json"
  );
  _assets = response.data;
};

// TODO Update to get the data from a secured location from nft20
let _webhooks;
const GetWebhooks = async () => {
  const { webhooks } = require("./nft20TradeBot/config.json");
  _webhooks = webhooks;
};

// There is a lot of info we have to work with
// Will need to figure out the best format for the messages
const formatEmbed = (transfer, offset = 0) => {
  const {
    name,
    symbol,
    transactionhash,
    timestamp,
    pool,
    ids,
    amounts,
    nft_name,
    nft_image,
    type,
  } = transfer;
  const asset = _assets.filter((a) => a.symbol === symbol)[0];
  if (asset == null) {
    console.log(
      `There is not an asset for ${name} or the symbols do not match`
    );
  }
  const { logo, color, uniswap, website } = { ...asset };

  let nfts = [];
  let end = offset + 14 > ids.length ? ids.length : offset + 14;
  for (var i = offset; i < end; i++) {
    nfts.push({
      name: "\u200b",
      value: `[**${nft_name[i]}** **${
        amounts[i] < 0 ? `${amounts[i]}` : `+${amounts[i]}`
      }**\n(#${ids[i]})](${nft_image[i]})`,
      inline: true,
    });
  }
  const fields = [
    ...nfts,
    {
      name: "\u200b",
      value: "\u200b",
    },
    {
      name: "\u200b",
      value: `[**TxHash**](https://etherscan.io/tx/${transactionhash})`,
      inline: true,
    },
    {
      name: "\u200b",
      value: `[**NFT20**](https://nft20.io/asset/${pool})`,
      inline: true,
    },
    {
      name: "\u200b",
      value: `[**${symbol}**](https://etherscan.io/token/${pool})`,
      inline: true,
    },
  ];
  if (uniswap) {
    fields.push({
      name: "\u200b",
      value: `[**Uniswap**](${uniswap})`,
      inline: true,
    });
  }
  if (website) {
    fields.push({
      name: "\u200b",
      value: `[**Website**](${website})`,
      inline: true,
    });
  }
  const embed = new Discord.MessageEmbed()
    .setColor(color ? color : "#ffffff")
    .setAuthor(name, logo, `https://nft20.io/asset/${pool}`)
    .setDescription(
      asset
        ? ""
        : "(Please update [assets.json](https://github.com/verynifty/nft20-assets/blob/master/assets.json) for this asset)"
    )
    .setTitle(`NFT20 ${type}`)
    .setThumbnail(logo)
    .addFields(fields)
    .setTimestamp(timestamp);

  return { symbol, embed };
};

const createEmbeds = (transfers) => {
  //Transfers will come in newest to oldest so reverse them for posting
  transfers.reverse();
  embeds = [];
  for (var i = 0; i < transfers.length; i++) {
    // Hard limit of 20 fields for discord embeds so transfers with more than 14 nfts
    //  will need to be split into multiple embeds
    for (var j = 0; j < transfers[i].ids.length; j += 14) {
      const msgEmbed = formatEmbed(transfers[i], j);
      embeds.push(msgEmbed);
    }
  }

  return embeds;
};

const postEmbeds = (embeds) => {
  for (const webhook of _webhooks) {
    const { id, pools, token } = webhook;
    const embedsToPost = embeds
      .filter(({ symbol }) => {
        return pools.includes(symbol);
      })
      .map(({ embed }) => {
        return embed;
      });
    client
      .fetchWebhook(id, token)
      .then((webhook) => {
        for (var i = 0; i < embedsToPost.length; i += 10) {
          const embedchunk = [];
          for (var j = 0; j < 10 && j + i < embedsToPost.length; j++) {
            embedchunk.push(embedsToPost[i + j]);
          }
          webhook
            .send({
              username: "NFT20 Trade",
              avatarURL:
                // TODO Update Name and Image or remove to let the webhook creator determine name and image
                "https://gallery.verynifty.io/img/VNFT%20LogoMark%20Green@3x.a38ab66c.png",
              embeds: embedchunk,
            })
            .catch((err) => {
              console.log(`Job 1: Webhook ${id}: Send Failure: ${err}`);
            });
        }
      })
      .catch((err) => {
        console.log(`Job 1: Webhook ${id}: Fetch Failure: ${err}`);
      });
  }
};

const CronJob = require("cron").CronJob;
const _apiUrl = "https://api.nft20.io/activity";
const _perPage = 100;
let _etag;
let _lastBlocknumber;
let _lastTimestamp;

const job = new CronJob("0 */1 * * * *", async function () {
  let start = new Date();
  console.log(`Begin Job 1 (Every minute): ${start}`);
  try {
    let response = await axios.get(_apiUrl, {
      ...(_etag && {
        headers: {
          "If-None-Match": _etag,
        },
      }),
      params: {
        page: 1,
        perPage: _perPage,
      },
    });
    const {
      data,
      headers: { etag },
    } = response;
    // Save etag to utilize caching
    _etag = etag;

    // Set the last block/time to the first event if the vars are null
    // If the bot is started we do not want to post duplicated transfers
    // Will result in loss of transfer posts if a transfer happens in between
    // bot down time. Could eventually add in a way to start from the right spot.
    if (_lastBlocknumber == null || _lastTimestamp == null) {
      console.log(
        "Job 1: Saved block or timestamp is null, resetting to newest event"
      );
      const { blocknumber, timestamp } = data.data[0];
      _lastBlocknumber = blocknumber;
      _lastTimestamp = new Date(timestamp);
    }

    // Our activity variable will hold all data
    let activity = [];

    // Check if we need to paginate (will run once always to add page 1 to activity)
    // We need to paginate if more than 1 page's worths of transactions have occured since last job
    // Repeat check at each page to determine when to stop (dont go through all pages if we don't have to)
    let paging = true;
    let currentPage = data;
    while (paging) {
      const { data, pagination } = currentPage;
      const { currentPage: pageNumber, lastPage } = pagination;
      // Add current page data to activity
      activity.push(...data);

      const oldestEvent = data[data.length - 1];

      const {
        blocknumber: oldestBlocknumber,
        timestamp: oldestTimestamp,
      } = oldestEvent;

      // Compare last event on page to last stored event to see if we need next page
      if (
        pageNumber >= lastPage ||
        (oldestBlocknumber <= _lastBlocknumber &&
          new Date(oldestTimestamp) <= _lastTimestamp)
      ) {
        paging = false;
        continue;
      }

      // Get next page
      const nextPage = pageNumber + 1;
      console.log("Job 1: Retrieving page ", nextPage);
      const response = await axios.get(_apiUrl, {
        params: {
          page: nextPage,
          perPage: _perPage,
        },
      });
      currentPage = response.data;
    }
    // Filter events based on block/time since last run
    activity = activity.filter(({ blocknumber, timestamp }) => {
      return (
        blocknumber > _lastBlocknumber && new Date(timestamp) > _lastTimestamp
      );
    });

    if (activity.length > 0) {
      // Update lastest block/time now that we have filtered the data
      const {
        blocknumber: latestBlockNumber,
        timestamp: latestTimeStamp,
      } = activity[0];
      _lastBlocknumber = latestBlockNumber;
      _lastTimestamp = new Date(latestTimeStamp);

      // We have events to post!
      console.log(`Job 1: There are ${activity.length} events to post!`);

      const embeds = createEmbeds(activity);
      postEmbeds(embeds);
    } else {
      console.log("Job 1: No events after filtering");
    }
  } catch (error) {
    const { response } = error;
    if (response != null) {
      const { status } = response;
      switch (status) {
        case 304:
          console.log("Job 1: 304: No new data");
          break;
        case 404:
          console.log("Job 1: 404: Server error");
          break;
        default:
          console.log("Job 1: Response Status: ", status);
      }
    } else {
      console.log(`Job 1: ${error}`);
    }
  }
  const end = new Date();
  const endTime = Math.abs(start - end);
  console.log(`End Job 1 (${endTime} ms): ${end}`);
});

const job2 = new CronJob("0 0 */1 * * *", async function () {
  let start = new Date();
  console.log(
    `Begin Job 2 (Every hour on the minute e.g. 01:00, 2:00, ...): ${start}`
  );
  console.log("Job 2: Retrieving assets...");
  await GetAssets();
  const end = new Date();
  const endTime = Math.abs(start - end);
  console.log(`End Job 2 (${endTime} ms): ${end}`);
});

const job3 = new CronJob("0 */30 * * * *", async function () {
  let start = new Date();
  console.log(
    `Begin Job 3 (Every half hour on the minute e.g. 01:00, 1:30, ...): ${start}`
  );
  console.log("Job 3: Retrieving webhooks...");
  await GetWebhooks();
  const end = new Date();
  const endTime = Math.abs(start - end);
  console.log(`End Job 3 (${endTime} ms): ${end}`);
});

client.once("ready", () => {
  console.log("Bot is ready");
});

const startBot = async () => {
  console.log("Starting bot...");
  console.log("Retrieving assets...");
  await GetAssets();
  console.log("Retrieving webhooks...");
  await GetWebhooks();
  await client.login(process.env.DISCORD);
  console.log("Starting cron jobs...");
  job.start();
  job2.start();
  job3.start();
};
startBot();
