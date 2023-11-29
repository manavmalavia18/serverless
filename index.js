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
            .on('finish', () => {
                const encodedGcsFileName = encodeURIComponent(gcsFileName);
                resolve(`https://storage.googleapis.com/${bucketName}/${encodedGcsFileName}`);
            })
            .on('error', (error) => reject(`Error uploading to ${gcsFileName}: ${error}`));
        });
    } catch (error) {
        if (error.message === 'File is not a ZIP' || error.message === 'File size is 0 bytes') {
            console.error('Error downloading file:', error.message);
            throw error;
        } else {
            console.error('Error downloading file: Invalid Url');
            throw new Error('Invalid Url');
        }
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

    let emailDetails = {
        id: uuidv4(), 
        sender_email: sender_email,
        receiver_email: receiver_email,
        email_subject: '',
        email_body: '',
        messageStatus: ''
    };

    

    try {
        console.log("Generating GCS file name...");
        const formattedSubmissionTime = submissionTime.replace(/:/g, '-').replace(/\./g, '-');
        const gcsFileName = `${bucketName}/${firstName}_${lastName}_${assignmentName}_${formattedSubmissionTime}`;
        console.log(`GCS file name generated: ${gcsFileName}`);
        
        console.log("Downloading and uploading file to GCS...");
        const publicUrl = await downloadAndUploadToGCS(submissionUrl, gcsFileName);
        console.log(`File uploaded, public URL: ${publicUrl}`);

        // Send success email after successful upload
        emailDetails.email_subject = 'Mailgun Test';
        // Simplified Email Body with GCS Filename and Public URL
        emailDetails.email_body = `Hello ${userEmail},

        I hope this message finds you well. We're pleased to let you know that your recent submission has been successfully received and securely stored.

        Here's the link to access your submission: ${publicUrl}
        And this is your Google Cloud Storage (GCS) path for the submission: ${gcsFileName}

        Should you have any questions or need assistance, our dedicated support team is ready to help at noreply@demo.me.

        Your privacy and the security of your data are our top priorities. Rest assured, we handle your personal information with the utmost care and confidentiality.

        Thank you for being a valued member of our community.

        Best regards,
        The Canvas Team`;


        emailDetails.messageStatus = 'success';

        console.log("Sending success email...");
        await sendMail(sender_email, receiver_email, emailDetails.email_subject, emailDetails.email_body);
        console.log("Success email sent successfully.");

    } catch (error) {
        console.error('Error handling file:', error);

        // Send error email
        emailDetails.email_subject = 'Error with Your Submission';
        emailDetails.email_body = `Hello,

        We regret to inform you that there was an issue with your recent submission. Error Message: ${error.message}. We assure you that resolving this is our priority.

        Please verify that your submission file is correctly formatted as a ZIP file and that it is not empty (i.e., not zero bytes) before resubmitting. Prompt attention to this matter will ensure your work is processed efficiently.

        We appreciate your cooperation and look forward to your corrected submission.

        Sincerely,
        The Canvas Team`;

        emailDetails.messageStatus = 'failure';

        await sendMail(sender_email, receiver_email, emailDetails.email_subject, emailDetails.email_body);
        console.log("Error notification email sent to receiver.");
    }

    console.log("Preparing email details for DynamoDB...");
    console.log(`Email details: ${JSON.stringify(emailDetails)}`);

    console.log("Inserting email record to DynamoDB...");
    await insertEmailRecordToDynamoDB(emailDetails);
    console.log("Email record inserted to DynamoDB successfully.");
}
