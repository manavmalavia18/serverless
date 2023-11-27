const formData = require('form-data');
const Mailgun = require('mailgun.js');
const mailgun = new Mailgun(formData);
const { Storage } = require('@google-cloud/storage');
const axios = require('axios');
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

AWS.config.update({
    region: 'us-west-2',
    accessKeyId: process.env.AWS_ACCESSKEY, 
    secretAccessKey: process.env.AWS_SECRET_ACCESSKEY 
});

const dynamoDb = new AWS.DynamoDB.DocumentClient();

const mg = mailgun.client({
    username: 'api',
    key: process.env.MAILGUN_API_KEY, 
});


const sendMail = async (sender_email, receiver_email, email_subject, email_body) => {
    const data = {
        from: sender_email,
        to: receiver_email,
        subject: email_subject,
        text: email_body
    };

    try {
        const body = await mg.messages.create('manavmalavia.me', data); 
        console.log(body);
    } catch (error) {
        console.error(error);
    }
};

async function insertEmailRecordToDynamoDB(record) {
    const params = {
        TableName: process.env.DYNAMODB_TABLE_NAME, 
        Item: record
    };

    return dynamoDb.put(params).promise();
}

const gcpServiceKey = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
const storage = new Storage({
    credentials: gcpServiceKey
});
const bucketName = process.env.BUCKET_NAME; 

const downloadAndUploadToGCS = async (url, gcsFileName) => {
    try {
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream'
        });

        const contentType = response.headers['content-type'];
        if (contentType !== 'application/zip') {
            throw new Error('File is not a ZIP');
        }

        const contentLength = response.headers['content-length'];
        if (parseInt(contentLength) === 0) {
            throw new Error('File size is 0 bytes');
        }

        const file = storage.bucket(bucketName).file(gcsFileName).createWriteStream({
            metadata: { contentType }
        });

        return new Promise((resolve, reject) => {
            response.data.pipe(file)
                .on('finish', () => resolve(`File uploaded to ${gcsFileName} in bucket ${bucketName}`))
                .on('error', (error) => reject(`Error uploading to ${gcsFileName}: ${error}`));
        });
    } catch (error) {
        console.error('Error downloading file:', error);
        throw error;
    }
};

exports.handler = async (event) => {
    console.log("Received SNS event:", JSON.stringify(event, null, 2));

    const record = event.Records[0];
    const snsMessage = JSON.parse(record.Sns.Message);
    const receiver_email = snsMessage.userEmail;  
    const submissionUrl = snsMessage.submission_url; 

    // Extracting additional details from the SNS message
    const firstName = snsMessage.firstName;
    const lastName = snsMessage.lastName;
    const assignmentName = snsMessage.assignmentName;
    const submissionTime = snsMessage.submissionTime;

    let sender_email = 'mailgun@manavmalavia.me'; 
    let email_subject = 'Mailgun Test';
    let email_body = `Hello there!

    Your recent assignment submission was successful - it's now safely stored in our digital vaults. 
    
    Fun fact: Did you know that your assignment was so bright, it turned off the dark mode on our server? 😉
    
    Keep up the great work, and if you have any more brilliant submissions, you know where to send them!
    
    Cheers,
    The Friendly Team at ManavMalavia.me`;

    console.log("Sending email...");
    await sendMail(sender_email, receiver_email, email_subject, email_body);
    console.log("Email sent successfully.");

    try {
        console.log("Generating GCS file name...");
        const formattedSubmissionTime = submissionTime.replace(/:/g, '-').replace(/\./g, '-');
        const gcsFileName = `${bucketName}/webapp/${firstName}_${lastName}_${assignmentName}_${formattedSubmissionTime}`;
        console.log(`GCS file name generated: ${gcsFileName}`);

        console.log("Downloading and uploading file to GCS...");
        const message = await downloadAndUploadToGCS(submissionUrl, gcsFileName);
        console.log(message); 

        console.log("Preparing email details for DynamoDB...");
        const emailDetails = {
            id: uuidv4(), 
            sender_email: sender_email,
            receiver_email: receiver_email,
            email_subject: email_subject,
            email_body: email_body,
        }
        console.log(`Email details: ${JSON.stringify(emailDetails)}`);

        console.log("Inserting email record to DynamoDB...");
        await insertEmailRecordToDynamoDB(emailDetails);
        console.log("Email record inserted to DynamoDB successfully.");
    } catch (error) {
        console.error('Error handling file:', error);
        if (error.message === 'File is not a ZIP' || error.message === 'File size is 0 bytes') {
            const errorSubject = 'Error with Your Submission';
            const errorBody = `Hello, there was an error with your file submission: ${error.message}`;
            await sendMail(sender_email, receiver_email, errorSubject, errorBody);
            console.log("Notification email sent to receiver about the error.");
        }
    
    }
};
