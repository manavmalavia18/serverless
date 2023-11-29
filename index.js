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
        from: `Webapp API <${sender_email}>`,
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
        const gcsFileName = `${firstName}_${lastName}_${assignmentName}_${formattedSubmissionTime}`;
        console.log(`GCS file name generated: ${gcsFileName}`);
        
        console.log("Downloading and uploading file to GCS...");
        const publicUrl = await downloadAndUploadToGCS(submissionUrl, gcsFileName);
        console.log(`File uploaded, public URL: ${publicUrl}`);

        // Send success email after successful upload
        emailDetails.email_subject = 'Assignment Submission Status- Successfully Submitted';
    
        emailDetails.email_body = `Greetings ${firstName},

        We're pleased to inform you that your recent submission has been successfully processed and stored.


        - Your Google Cloud Storage Path: '${bucketName}/${gcsFileName}'


        If you have any questions or require assistance, please don't hesitate to reach out to our support team . We're here to help.

        Your privacy and data security are paramount to us. We adhere to strict privacy policies to ensure that your information is always handled with care.

        Thank you for choosing our platform for your academic needs.

        Best regards,
        The Canvas Team`

        emailDetails.messageStatus = 'success';

        console.log("Sending success email...");
        await sendMail(sender_email, receiver_email, emailDetails.email_subject, emailDetails.email_body);
        console.log("Success email sent successfully.");

    } catch (error) {
        console.error('Error handling file:', error);

        emailDetails.email_subject = 'Assignment Submission Status-Error with Your Submission';
        
        emailDetails.email_body = `Hello ${firstName},

        We have an update regarding your recent submission. An issue was detected: ${error.message}. We are actively working to resolve this.

        To assist in this process, please ensure your submission file is a ZIP format and not empty before resubmitting. This will aid in efficient processing.

        Your cooperation is greatly appreciated, and we are eager to receive your corrected submission.

        Kind regards,
        The Canvas Team`

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
