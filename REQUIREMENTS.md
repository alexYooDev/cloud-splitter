# Split-down: Split download the bulky files to your device

## Usecases

### Low capacity in Local drive (Main)

Problem: When you have only 10GB capacity in your local machine and need to download 50GB photos backup

Solution: Set the destination directory for download and select "batch download" to 4GB. This allows splitting 50GB files into multiple 4GB files and you can resume after moving the previous downloads to outside storage.


### Frequent network disruption & disconnection while downloading

Problem: The download of 100GB files (possibly long download time) fails during the process

Solution: Set "batch download" to 10GB, and it securely saves partial files even when disconnected or disruption on the way (e.g. divide ZIP as Part_1, Part_2). Resume from the failure point. (resume back from Part_3 using transaction)

### Administrator dealing with large files transfer

Problem: Need to send 15GB project folder to the client/partner firm, their secure portal only allow 2GB or less ZIP file per upload.

Solution: Select "batch download" and set to 2GB at a time and then upload, without having to download the whole and manually divide the project folder ZIP.

### User Action Flow

The goal of the user of this app is to download the large bulky files or ZIPPED folders to local device, split into multiple smaller partitions.

These are the essential steps to acheive the goal:

1. Connect to the cloud storage service (3rd Party) - needed only once initially
    - Start the app, and click connect to "Google Drive" or "OneDrive" to allow user to get authorized.

2. Select the target directory for download
    - From the cloud finder UI, select the target folder (or a file)

3. Select download path and configure partition setting
    - After clicking "download" button, set the target download folder and set the target partition size (2GB, 4GB, or custom setting)

4. Streaming processing and monitoring
    - While the system reads files from the cloud and immediately compresses the target folder (or files) into ZIP, the user can still view "the part being processed" and the "total progress" from the progress tracker.

5. Completion and checking the result
    - Once the download process is completed, the result is displayed on the screen. The user can click "open saved folder" to confirm the outcome.

