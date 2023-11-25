const formData = require('form-data');
const Mailgun = require('mailgun.js');
const mailgun = new Mailgun(formData);
const { Storage } = require('@google-cloud/storage');
const axios = require('axios');


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

        const file = storage.bucket(bucketName).file(gcsFileName).createWriteStream({
            metadata: {
                contentType: 'application/zip' 
            }
        });

        return new Promise((resolve, reject) => {
            response.data.pipe(file)
                .on('finish', () => {
                    resolve(`File uploaded to ${gcsFileName} in bucket ${bucketName}`);
                })
                .on('error', (error) => {
                    reject(`Error uploading to ${gcsFileName}: ${error}`);
                });
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

    let sender_email = 'mailgun@manavmalavia.me'; 
    let email_subject = 'Mailgun Test';
    let email_body = 'Data received from SNS';



    await sendMail(sender_email, receiver_email, email_subject, email_body);

    try {
        const gcsFileName = `${bucketName}/webapp`;
        const message = await downloadAndUploadToGCS(submissionUrl, gcsFileName);
        console.log(message);
    } catch (error) {
        console.error('Error handling file:', error);
    }
};