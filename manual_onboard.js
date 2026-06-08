const notion = require('./services/notion');
const resend = require('./services/resend');
const log = require('./utils/logger');
const moment = require('moment-timezone');

async function fixStuckMembers() {
  console.log("Checking for stuck members...");
  // Use Notion client to query directly because notion service might not have a generic query for "bekliyor"
  const { Client } = require("@notionhq/client");
  const { config } = require('./config/env');
  const notionClient = new Client({ auth: config.notionApiKey });

  const response = await notionClient.databases.query({
    database_id: config.notionDatabaseId,
    filter: {
      property: "Onboarding Durumu",
      select: {
        equals: "bekliyor"
      }
    }
  });

  console.log(`Found ${response.results.length} members with status "bekliyor"`);

  for (const page of response.results) {
    const props = page.properties;
    const name = props["İsim"]?.title?.[0]?.plain_text || "İsimsiz";
    const email = props["Email"]?.email;
    const txId = props["Skool ID"]?.rich_text?.[0]?.plain_text || "N/A";
    
    if (email) {
      console.log(`Triggering email onboarding for ${name} (${email})`);
      
      // Update Notion
      await notionClient.pages.update({
        page_id: page.id,
        properties: {
          "Onboarding Durumu": { select: { name: "email" } },
          "Onboarding Kanalı": { select: { name: "email" } },
          "Onboarding Adımı": { number: 0 }
        }
      });
      
      // Send email
      try {
        await resend.sendOnboardingEmail(email, name, 0);
        console.log(`Email successfully sent to ${email}`);
      } catch (err) {
        console.error(`Error sending email to ${email}:`, err.message);
      }
    } else {
      console.log(`Skipping ${name} - no email found.`);
    }
  }
}

fixStuckMembers().then(() => {
  console.log("Done");
  process.exit(0);
}).catch(console.error);
