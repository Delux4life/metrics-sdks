# ReadMe Metrics

<p align="center">
  <img src="https://user-images.githubusercontent.com/33762/182927634-2aebeb46-c215-4ac3-9e98-61f931e33583.png" />
</p>

<p align="center">
  Track usage of your API and troubleshoot issues faster.
</p>

<p align="center">
  <a href="https://packagist.org/packages/readme/metrics"><img src="https://img.shields.io/packagist/v/readme/metrics.svg?style=for-the-badge" alt="Latest release"></a>
  <a href="https://packagist.org/packages/readme/metrics"><img src="https://img.shields.io/packagist/php-v/readme/metrics.svg?style=for-the-badge" alt="Supported PHP versions"></a>
  <a href="https://github.com/readmeio/metrics-sdks"><img src="https://img.shields.io/github/workflow/status/readmeio/metrics-sdks/php.svg?style=for-the-badge" alt="Build status"></a>
</p>

With [ReadMe's Metrics API](https://readme.com/metrics) your team can get deep insights into your API's usage. If you're a developer, it takes a few small steps to send your API logs to [ReadMe](http://readme.com). Here's an overview of how the integration works:

- You add the ReadMe middleware to your [Laravel](https://laravel.com/) application.
- The middleware sends to ReadMe the response object that your Laravel application generates each time a user makes a request to your API. The entire response is sent, unless you allow or deny keys.
- ReadMe populates Metrics with this information, such as which endpoint is being called, response code, and error messages. It also identifies the customer who called your API, using whichever keys in the middleware you call out as containing relevant customer info.

```
composer require readme/metrics
```

**For more information on setup, check out our [integration documentation](https://docs.readme.com/docs/sending-logs-to-readme-with-php-laravel).**

> 🚧 Any Issues?
>
> Integrations can be tricky! [Contact support](https://docs.readme.com/guides/docs/contact-support) if you have any questions/issues.
